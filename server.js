const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// --- 1. КОНФИГУРАЦИЯ ---
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const { MONGODB_URI } = process.env;
const APP_URL = (process.env.APP_URL || 'https://dbd-mmr.onrender.com').replace(/\/+$/, '');
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (!MONGODB_URI || !STEAM_API_KEY || !SESSION_SECRET) {
  throw new Error('Не заданы обязательные переменные MONGODB_URI, STEAM_API_KEY и SESSION_SECRET');
}

// --- 2. СХЕМЫ ДАННЫХ ---
const UserSchema = new mongoose.Schema({
  steamId: { type: String, unique: true, required: true },
  nickname: String,
  survivorMMR: { type: Number, default: 1000 },
  killerMMR: { type: Number, default: 1000 },
  lastUpdate: { type: Date, default: Date.now },
  syncKeyHash: { type: String, index: true }
});

const MatchSchema = new mongoose.Schema({
  steamId: { type: String, index: true },
  matchId: { type: String, unique: true },
  role: String,          // 'survivor' | 'killer'
  characterId: String,   // Например: 'S28' или 'K27'
  characterName: String, // Например: 'Mikaela Reid' или 'The Onryō'
  mapName: String,       // Например: 'Dead Sands'
  outcomeText: String,   // Например: 'Побег', 'Смерть', '3 убийства'
  kills: Number,         // 0-4 для убийцы, null для выжившего
  mmrChange: Number,     // +25, +15, -15, -25
  date: { type: Date, index: true }
});

const User = mongoose.model('User', UserSchema);
const Match = mongoose.model('Match', MatchSchema);

// --- 3. НАСТРОЙКА STEAM AUTH (Passport.js) ---
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
      } else if (user.nickname !== profile.displayName) {
        user.nickname = profile.displayName;
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

// --- 4. ЛОГИКА РАСЧЕТА MMR ---
const MMR_CONFIG = {
  survivor: {
    escape: 15, // Побег через ворота или люк
    death: -15  // Смерть, жертвоприношение, сдача или дисконнект
  },
  killer: {
    kills4: 25,  // 4 убитых / ливнувших
    kills3: 15,  // 3 убитых / ливнувших
    kills2: -15, // 2 убитых / ливнувших
    kills1: -25, // 1 убитый / ливнувший
    kills0: -25  // 0 убитых
  }
};

function isSurvivorEscapeStatus(statusId = '', statusName = '') {
  const combined = `${statusId} ${statusName}`.toUpperCase();
  return combined.includes('ESCAPED') || combined.includes('ESCAPE');
}

function isSurvivorDeadOrLeft(statusId = '', statusName = '', imagePath = '') {
  const combined = `${statusId} ${statusName} ${imagePath}`.toUpperCase();
  return /(SACRIFICED|KILLED|DEAD|MORI|BLEEDOUT|BLEED_OUT|SURRENDER|DISCONNECTED|DC|QUIT|LEFT|LOSS)/.test(combined);
}

function formatKillsText(kills) {
  if (kills === 1) return '1 убийство';
  if (kills >= 2 && kills <= 4) return `${kills} убийства`;
  return '0 убийств';
}

function calculateChange(match) {
  if (match?.matchStat?.isCustomMatch === true) {
    return { isCustom: true, isKiller: false, change: null, kills: null, outcomeText: null };
  }

  const p = match?.playerStat || {};
  const isKiller = p.playerRole === 'VE_Slasher' || !!p.killerMatchStatus;

  // 1. РАСЧЕТ ДЛЯ УБИЙЦЫ
  if (isKiller) {
    const opponents = Array.isArray(match.opponentStat) ? match.opponentStat : [];
    if (opponents.length === 0) {
      return { isCustom: false, isKiller: true, change: null, kills: null, outcomeText: null };
    }

    let kills = 0;
    for (const opp of opponents) {
      if (opp.playerRole === 'VE_Camper' || !opp.playerRole) {
        const sId = opp.playerStatus?.id || '';
        const sName = opp.playerStatus?.name || '';
        const sImg = opp.playerStatus?.image?.path || '';

        if (!isSurvivorEscapeStatus(sId, sName) && (isSurvivorDeadOrLeft(sId, sName, sImg) || !sId)) {
          kills++;
        }
      }
    }

    const safeKills = Math.min(kills, 4);
    let change = MMR_CONFIG.killer.kills0;
    if (safeKills >= 4) change = MMR_CONFIG.killer.kills4;
    else if (safeKills === 3) change = MMR_CONFIG.killer.kills3;
    else if (safeKills === 2) change = MMR_CONFIG.killer.kills2;
    else if (safeKills === 1) change = MMR_CONFIG.killer.kills1;

    return {
      isCustom: false,
      isKiller: true,
      change,
      kills: safeKills,
      outcomeText: formatKillsText(safeKills)
    };
  }

  // 2. РАСЧЕТ ДЛЯ ВЫЖИВШЕГО
  const sId = String(p.playerStatus?.id || '');
  const sName = String(p.playerStatus?.name || '');
  const sImg = String(p.playerStatus?.image?.path || '');

  if (isSurvivorEscapeStatus(sId, sName)) {
    return {
      isCustom: false,
      isKiller: false,
      change: MMR_CONFIG.survivor.escape,
      kills: null,
      outcomeText: 'Побег'
    };
  }

  if (isSurvivorDeadOrLeft(sId, sName, sImg)) {
    const isDC = /(DISCONNECTED|DC|QUIT|LEFT|SURRENDER)/.test(`${sId} ${sName} ${sImg}`.toUpperCase());
    return {
      isCustom: false,
      isKiller: false,
      change: MMR_CONFIG.survivor.death,
      kills: null,
      outcomeText: isDC ? 'Покинул матч / Сдался' : 'Смерть'
    };
  }

  return { isCustom: false, isKiller: false, change: null, kills: null, outcomeText: null };
}

function hashSyncKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

async function processMatchesForUser(user, rawMatches) {
  let totalSurvChange = 0;
  let totalKillChange = 0;
  let survivorMatchesProcessed = 0;
  let killerMatchesProcessed = 0;
  let matchesWithUnknownKills = 0;
  let survivorMatchesWithUnknownStatus = 0;
  const matchesToSave = [];
  const seenInBatch = new Set();

  const safeMatches = rawMatches.slice(0, 100);

  for (const match of safeMatches) {
    const startTime = Number(match?.matchStat?.matchStartTime);
    const charId = String(match?.playerStat?.characterName?.id || match?.playerStat?.playerRole || '').slice(0, 32);
    const charName = String(match?.playerStat?.characterName?.name || charId || 'Неизвестный').slice(0, 64);
    const mapName = String(match?.matchStat?.map?.name || match?.matchStat?.mapName || '').slice(0, 64);

    const sourceMatchId = match.id || (Number.isInteger(startTime) && startTime > 1598918400
      ? `${startTime}_${charId}`
      : null);

    if (!sourceMatchId) continue;

    const matchId = `${user.steamId}:${sourceMatchId}`;
    if (seenInBatch.has(matchId)) continue;
    seenInBatch.add(matchId);

    const alreadyProcessed = await Match.findOne({
      steamId: user.steamId,
      matchId: { $in: [matchId, sourceMatchId] }
    });

    if (!alreadyProcessed) {
      const { isCustom, isKiller, change, kills, outcomeText } = calculateChange(match);
      if (isCustom) continue;

      if (isKiller && change === null) {
        matchesWithUnknownKills++;
        continue;
      }
      if (!isKiller && change === null) {
        survivorMatchesWithUnknownStatus++;
        continue;
      }

      matchesToSave.push({
        steamId: user.steamId,
        matchId,
        role: isKiller ? 'killer' : 'survivor',
        characterId: charId,
        characterName: charName,
        mapName,
        outcomeText,
        kills,
        mmrChange: change,
        date: Number.isInteger(startTime) ? new Date(startTime * 1000) : new Date()
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

  let updatedUser = user;
  if (matchesToSave.length > 0) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Match.insertMany(matchesToSave, { ordered: true, session });
        const updateResult = await User.updateOne(
          { _id: user._id },
          {
            $inc: {
              survivorMMR: totalSurvChange,
              killerMMR: totalKillChange
            },
            $set: { lastUpdate: new Date() }
          },
          { session }
        );
        if (updateResult.matchedCount !== 1) {
          throw new Error('Пользователь не найден при сохранении MMR');
        }
      });
    } finally {
      await session.endSession();
    }

    updatedUser = await User.findById(user._id)
      .select('survivorMMR killerMMR')
      .lean();
    if (!updatedUser) {
      throw new Error('Не удалось загрузить обновленный профиль пользователя');
    }
  }

  return {
    survivorMMR: updatedUser.survivorMMR,
    killerMMR: updatedUser.killerMMR,
    changes: { survivor: totalSurvChange, killer: totalKillChange },
    processedMatches: {
      survivor: survivorMatchesProcessed,
      killer: killerMatchesProcessed
    },
    skippedMatches: {
      killerWithUnknownKills: matchesWithUnknownKills,
      survivorWithUnknownStatus: survivorMatchesWithUnknownStatus
    }
  };
}

// --- 5. ЭНДПОИНТЫ ---

app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/healthz', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
});

app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
  res.redirect(APP_URL);
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect(APP_URL);
  });
});

// Получение последних 50 матчей текущего пользователя
app.get('/api/user/matches', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const matches = await Match.find({ steamId: req.user.steamId })
      .sort({ date: -1 })
      .limit(50)
      .select('role characterId characterName mapName outcomeText kills mmrChange date -_id')
      .lean();
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: 'Не удалось загрузить историю матчей' });
  }
});

// Генерация ключа для авто-синхронизации из браузера
app.post('/api/user/sync-key', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Сначала войдите через Steam' });

  const rawKey = `dbd_${crypto.randomBytes(24).toString('hex')}`;
  req.user.syncKeyHash = hashSyncKey(rawKey);
  await req.user.save();

  res.json({ syncKey: rawKey });
});

// Авто-синхронизация со страницы stats.deadbydaylight.com
app.options('/api/user/sync-matches', (req, res) => {
  res.header('Access-Control-Allow-Origin', 'https://stats.deadbydaylight.com');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Key');
  res.sendStatus(204);
});

app.post('/api/user/sync-matches', async (req, res) => {
  res.header('Access-Control-Allow-Origin', 'https://stats.deadbydaylight.com');

  const syncKey = req.headers['x-sync-key'];
  if (!syncKey || typeof syncKey !== 'string' || syncKey.length < 20) {
    return res.status(401).json({ error: 'Отсутствует или неверный ключ синхронизации' });
  }

  try {
    const user = await User.findOne({ syncKeyHash: hashSyncKey(syncKey) });
    if (!user) {
      return res.status(401).json({ error: 'Ключ синхронизации недействителен или был перевыпущен' });
    }

    const rawMatches = req.body?.matches;
    if (!Array.isArray(rawMatches)) {
      return res.status(400).json({ error: 'Ожидался массив matches' });
    }

    const result = await processMatchesForUser(user, rawMatches);
    res.json({ message: 'Авто-синхронизация завершена', ...result });
  } catch (error) {
    console.error('Ошибка синхронизации:', error.message);
    res.status(500).json({ error: 'Ошибка сервера при синхронизации' });
  }
});

// Ручное обновление по токену
app.post('/api/user/update', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Сначала войдите через Steam' });

  const user = req.user;
  const rawToken = req.body.token || '';
  const token = String(rawToken).replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '');

  if (!token) return res.status(400).json({ error: 'Требуется токен Behavior' });

  try {
    const API_URL = 'https://account-backend.bhvr.com/player-stats/match-history/games/dbd/providers/bhvr?lang=en&limit=100';
    const response = await axios.get(API_URL, {
      headers: { 'authorization': `Bearer ${token}`, 'Referer': 'https://stats.deadbydaylight.com/' }
    });

    const rawData = response.data;
    const matches = Array.isArray(rawData)
      ? rawData
      : (rawData?.data || rawData?.matches || rawData?.items || null);

    if (!Array.isArray(matches)) {
      return res.status(502).json({ error: 'BHVR вернул историю матчей в неожиданном формате.' });
    }

    try {
      const result = await processMatchesForUser(user, matches);
      res.json({
        message: 'Обновление MMR завершено',
        ...result
      });
    } catch (error) {
      console.error('Ошибка сохранения истории матчей:', error.message);
      res.status(500).json({ error: 'Не удалось сохранить историю матчей' });
    }
  } catch (error) {
    const bhvrStatus = error.response?.status;
    if (bhvrStatus === 401) {
      return res.status(401).json({ error: 'BHVR отклонил токен: он истек или недействителен. Получите новый токен или настройте авто-синхронизацию.' });
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

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  res.json({
    steamId: req.user.steamId,
    nickname: req.user.nickname,
    survivorMMR: req.user.survivorMMR,
    killerMMR: req.user.killerMMR,
    lastUpdate: req.user.lastUpdate,
    hasSyncKey: !!req.user.syncKeyHash
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