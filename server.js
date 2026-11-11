const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const { MONGODB_URI } = process.env;
const APP_URL = (process.env.APP_URL || 'https://dbd-mmr.onrender.com').replace(/\/+$/, '');
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (!MONGODB_URI || !STEAM_API_KEY || !SESSION_SECRET) {
  throw new Error('Не заданы обязательные переменные MONGODB_URI, STEAM_API_KEY и SESSION_SECRET');
}


// 2. СХЕМЫ ДАННЫХ
const UserSchema = new mongoose.Schema({
  steamId: { type: String, unique: true, required: true },
  nickname: String,
  survivorMMR: { type: Number, default: 1000 },
  killerMMR: { type: Number, default: 1000 },
  lastUpdate: { type: Date, default: Date.now },
  behaviorToken: String // Теперь храним токен здесь для авто-обновления
});

const MatchSchema = new mongoose.Schema({
  steamId: String,
  matchId: { type: String, unique: true },
  role: String,
  mmrChange: Number,
  date: Date
});

const User = mongoose.model('User', UserSchema);
const Match = mongoose.model('Match', MatchSchema);

// 3. НАСТРОЙКА STEAM AUTH (Passport.js)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new SteamStrategy({
    returnURL: `${APP_URL}/auth/steam/return`,
    realm: `${APP_URL}/`,
    apiKey: STEAM_API_KEY
  },
  async (identifier, profile, done) => {
    try {
      const steamId = profile.id;
      let user = await User.findOne({ steamId });
      if (!user) {
        user = new User({
          steamId,
          nickname: profile.displayName
        });
        await user.save();
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// 4. ЛОГИКА РАСЧЕТА MMR
const MMR_CONFIG = {
  survivor: { escape: 15, death: -15 },
  killer: { kills4: 25, kills3: 15, kills2: -15, kills1: -25, kills0: -25 }
};

function calculateChange(match) {
  const p = match.playerStat || {};
  if (p.killerMatchStatus) {
    const rawKills = p.killerMatchStatus.kills;
    if (rawKills === undefined || rawKills === null || rawKills === '') return null;
    const kills = Number(rawKills);
    if (!Number.isInteger(kills) || kills < 0) return null;
    if (kills >= 4) return MMR_CONFIG.killer.kills4;
    if (kills === 3) return MMR_CONFIG.killer.kills3;
    if (kills === 2) return MMR_CONFIG.killer.kills2;
    if (kills === 1) return MMR_CONFIG.killer.kills1;
    return MMR_CONFIG.killer.kills0;
  } else {
    const status = String(p.playerStatus?.id || '').toUpperCase();
    return status.includes('ESCAPED') ? MMR_CONFIG.survivor.escape : MMR_CONFIG.survivor.death;
  }
}

// 5. ЭНДПОИНТЫ

app.get(['/','/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/healthz', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
});

// Авторизация Steam
app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
  res.redirect(APP_URL);
});

// Выход
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect(APP_URL);
  });
});

// Обновление MMR (теперь может использовать сохраненный токен)
app.post('/api/user/update', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Сначала войдите через Steam' });

  const user = req.user;
  const rawToken = req.body.token || user.behaviorToken || '';
  const token = String(rawToken).replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '');

  if (!token) return res.status(400).json({ error: 'Требуется токен Behavior' });

  try {
    const API_URL = 'https://account-backend.bhvr.com/player-stats/match-history/games/dbd/providers/bhvr?lang=en&limit=100';
    const response = await axios.get(API_URL, {
      headers: { 'authorization': `Bearer ${token}`, 'Referer': 'https://stats.deadbydaylight.com/' }
    });

    const matches = response.data;
    if (!Array.isArray(matches)) {
      return res.status(502).json({ error: 'BHVR вернул историю матчей в неожиданном формате.' });
    }

    let totalSurvChange = 0;
    let totalKillChange = 0;
    let survivorMatchesProcessed = 0;
    let killerMatchesProcessed = 0;
    let matchesWithUnknownKills = 0;
    const matchesToSave = [];

    for (const match of matches) {
      const sourceMatchId = match.id || JSON.stringify(match);
      const matchId = `${user.steamId}:${sourceMatchId}`;
      const alreadyProcessed = await Match.findOne({
        steamId: user.steamId,
        matchId: { $in: [matchId, sourceMatchId] }
      });
      if (!alreadyProcessed) {
        const change = calculateChange(match);
        const isKiller = !!match.playerStat?.killerMatchStatus;
        if (isKiller && change === null) {
          matchesWithUnknownKills++;
          continue;
        }
        matchesToSave.push({
            steamId: user.steamId,
            matchId,
            role: isKiller ? 'killer' : 'survivor',
            mmrChange: change,
            date: new Date()
        });
        if (isKiller) {
          totalKillChange += change;
          killerMatchesProcessed++;
        } else {
          totalSurvChange += change;
          survivorMatchesProcessed++;
        }
      }
    }

    if (matchesToSave.length > 0) {
      await Match.create(matchesToSave);
    }

    if (user) {
      user.behaviorToken = token;
        user.survivorMMR += totalSurvChange;
        user.killerMMR += totalKillChange;
        user.lastUpdate = new Date();
        await user.save();
    }

    res.json({
      message: 'Обновление MMR завершено',
      survivorMMR: user.survivorMMR,
      killerMMR: user.killerMMR,
      changes: { survivor: totalSurvChange, killer: totalKillChange },
      processedMatches: {
        survivor: survivorMatchesProcessed,
        killer: killerMatchesProcessed
      },
      skippedMatches: {
        killerWithUnknownKills: matchesWithUnknownKills
      }
    });
  } catch (error) {
    const bhvrStatus = error.response?.status;
    if (bhvrStatus === 401) {
      return res.status(401).json({ error: 'BHVR отклонил токен: он истек или недействителен. Получите новый токен.' });
    }
    if (bhvrStatus === 403) {
      return res.status(403).json({ error: 'BHVR запретил запрос. Проверьте, что токен получен в аккаунте Behavior.' });
    }
    console.error('Ошибка запроса к BHVR:', bhvrStatus || error.code || error.message);
    res.status(502).json({ error: 'Не удалось получить историю матчей от BHVR. Попробуйте позже.' });
  }
});

app.get('/api/leaderboard/:role', async (req, res) => {
  const { role } = req.params;
  if (role !== 'survivor' && role !== 'killer') {
    return res.status(400).json({ error: 'Неизвестная роль' });
  }
  const field = role === 'survivor' ? 'survivorMMR' : 'killerMMR';
  try {
    const topPlayers = await User.find()
      .select('steamId nickname survivorMMR killerMMR -_id')
      .sort({ [field]: -1 })
      .limit(100)
      .lean();
    res.json(topPlayers);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Текущий пользователь (для фронтенда)
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  res.json({
    steamId: req.user.steamId,
    nickname: req.user.nickname,
    survivorMMR: req.user.survivorMMR,
    killerMMR: req.user.killerMMR,
    lastUpdate: req.user.lastUpdate
  });
});

async function startServer() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB подключена');
  app.listen(PORT, () => console.log(`🚀 Сервер с поддержкой Steam запущен на порту ${PORT}`));
}

startServer().catch(error => {
  console.error('❌ Не удалось запустить сервер:', error.message);
  process.exit(1);
});
