import { DatabaseSync } from 'node:sqlite'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { embedText, getEmbeddingModelId, getEmbeddingDims, warmupEmbeddingProvider, configureEmbedding, consumeProviderSwitchEvent } from './embedding-provider.mjs'
import {
  cleanMemoryText,
  composeTaskDetails,
  parseTaskDetails,
  isProfileRelatedText,
  shouldKeepFact,
  shouldKeepSignal,
} from './memory-extraction.mjs'
import {
  buildFtsQuery,
  extractExplicitDate,
  firstTextContent,
  getShortTokensForLike,
  insertCandidateUnits,
  looksLowSignal,
  propositionSubjectTokens,
  shortTokenMatchScore,
  tokenizeMemoryText,
} from './memory-text-utils.mjs'
import {
  SCOPED_LANE_PRIOR,
  isProfileIntent,
  isPolicyIntent,
  getIntentTypeCaps,
  getIntentSubtypeBonus,
  shouldKeepRerankItem,
  computeSourceTrustAdjustment,
  computeSecondStageRerankScore,
  getSecondStageThreshold,
  compactRetrievalContent,
  collapseClaimSurfaceDuplicates,
} from './memory-ranking-utils.mjs'
import {
  buildMemoryQueryPlan,
  isDoneTaskQuery,
  isOngoingTaskQuery,
  isRelationQuery,
  isRuleQuery,
  parseTemporalHint,
} from './memory-query-plan.mjs'
import {
  applyExactHistorySelection,
  buildHybridRetrievalInputs,
  getSeedResultsForPlan,
  summarizeRetrieverDebug,
} from './memory-retrievers.mjs'
import {
  applyMetadataFilters as applyMetadataFiltersImpl,
  bulkVerifyHints as bulkVerifyHintsImpl,
  getEntityRecallRows as getEntityRecallRowsImpl,
  getEpisodeRecallRows as getEpisodeRecallRowsImpl,
  getPolicyRecallRows as getPolicyRecallRowsImpl,
  getProfileRecallRows as getProfileRecallRowsImpl,
  getRecallShortcutRows as getRecallShortcutRowsImpl,
  getRelationRecallRows as getRelationRecallRowsImpl,
  verifyMemoryClaim as verifyMemoryClaimImpl,
} from './memory-recall-store.mjs'
import {
  countEpisodes as countEpisodesImpl,
  countPendingCandidates as countPendingCandidatesImpl,
  deleteRowsByIds as deleteRowsByIdsImpl,
  getCandidatesForDate as getCandidatesForDateImpl,
  getDecayRows as getDecayRowsImpl,
  getEpisodesSince as getEpisodesSinceImpl,
  getPendingCandidateDays as getPendingCandidateDaysImpl,
  getRecentCandidateDays as getRecentCandidateDaysImpl,
  listDeprecatedIds as listDeprecatedIdsImpl,
  markCandidateIdsConsolidated as markCandidateIdsConsolidatedImpl,
  markCandidatesConsolidated as markCandidatesConsolidatedImpl,
  markRowsDeprecated as markRowsDeprecatedImpl,
  pruneConsolidatedMemoryOutsideDays as pruneConsolidatedMemoryOutsideDaysImpl,
  rebuildCandidates as rebuildCandidatesImpl,
  resetConsolidatedMemory as resetConsolidatedMemoryImpl,
  resetConsolidatedMemoryForDays as resetConsolidatedMemoryForDaysImpl,
  resetEmbeddingIndex as resetEmbeddingIndexImpl,
  vacuumDatabase as vacuumDatabaseImpl,
} from './memory-maintenance-store.mjs'
import { buildInboundMemoryContext as buildInboundMemoryContextImpl } from './memory-context-builder.mjs'
import { DEFAULT_MEMORY_TUNING, mergeMemoryTuning } from './memory-tuning.mjs'
import { detectDevQueryBias, inferTaskActivity, inferTaskScope, isDevWorkstream, isDevelopmentFacet } from './memory-dev-utils.mjs'
import {
  applyLexicalIntentHints,
  detectProfileQuerySlot,
  normalizeProfileKey,
  profileKeyForFact,
  profileKeyForSignal,
  shouldKeepProfileValue,
} from './memory-profile-utils.mjs'
import {
  getConfiguredIntentBoost,
  getConfiguredTypeBoost,
  getProfileSlotRankAdjustment,
} from './memory-score-utils.mjs'
import {
  averageVectors,
  contextualizeEmbeddingInput,
  cosineSimilarity,
  embeddingItemKey,
  hashEmbeddingInput,
  vecToHex,
} from './memory-vector-utils.mjs'
let sqliteVec = null
try { sqliteVec = await import('sqlite-vec') } catch { /* sqlite-vec not available */ }

const stores = new Map()
const INTENT_PROTOTYPES = {
  profile: [
    'user language tone response style preference',
    'how should the assistant speak, write, and address the user',
    'preferred language, tone, and communication style',
    'preferred address style and communication rules',
    'how should the system respond to the user',
    'language and style preference rules',
    'formal respectful address style',
    'response tone and wording rules',
    'language and address behavior',
  ],
  task: [
    'current work status and active priorities',
    'what is in progress right now and what comes next',
    'ongoing execution state and next action',
    'present operational focus and pending work',
    'priority items in the current workflow',
    'near-term work status and planned next steps',
  ],
  decision: [
    'architecture decision design constraint rule limitation',
    'system design choice and implementation constraint',
    'agreed technical decision and structural direction',
    'design decision and structural rule',
    'technical direction and constraints',
    'agreed system decision',
  ],
  policy: [
    'policy rule restriction allowed forbidden operational behavior',
    'explicit constraint and operating rule',
    'workflow policy and behavioral restrictions',
    'what is allowed forbidden or required in operation',
    'system rule and user-imposed constraint',
    'operational guardrail and preference rule',
  ],
  security: [
    'secret credential sensitive value security privacy',
    'how sensitive data should be handled safely',
    'secure handling of protected values and access',
    'private information safety and credential management',
    'security restriction for confidential operational data',
    'handling of protected secrets and privileged access',
  ],
  event: [
    'past event incident timeline and what occurred',
    'time-bounded event trace from prior conversation',
    'what occurred at a specific time in history',
    'historical event reconstruction from conversation evidence',
    'trace a past occurrence using dated conversation context',
    'timeline-oriented recall of an earlier incident',
  ],
  history: [
    'recent history and discussed topics',
    'recent activity and prior conversation context',
    'what has been discussed recently',
    'near-term conversational history and recent work',
    'recent context and prior topics',
    'history of recent discussion and activity',
  ],
}
let intentPrototypeVectorsPromise = null
let intentPrototypeVectorsModelId = null

function logIgnoredError(scope, error) {
  if (!error) return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[memory] ${scope}: ${message}\n`)
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-')
}

export { cleanMemoryText }

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`
const DEBUG_RECALL_EPISODE_KIND_SQL = `'message', 'turn', 'transcript'`

function isTranscriptQuarantineContent(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.length >= 10000) return true
  if (clean.length > 2000 && /(?:^|\n)[ua]:\s/.test(clean)) return true
  if (/^you are summarizing a day's conversation\b/i.test(clean)) return true
  if (/^you are compressing summaries\b/i.test(clean)) return true
  if (/below is the cleaned conversation log/i.test(clean)) return true
  if (/output only the summary/i.test(clean) && /what tasks were worked on/i.test(clean)) return true
  if (/summarize in ~?\d+ lines/i.test(clean) && /date:\s*\d{4}-\d{2}-\d{2}/i.test(clean)) return true
  if (/^you are (analyzing|consolidating|improving|summarizing)\b/i.test(clean)) return true
  if (/^summarize the conversation\b/i.test(clean)) return true
  if (/history directory:/i.test(clean) && /read existing files/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  if (/output json only/i.test(clean) && /(memory system|claude2bot|c2b)/i.test(clean)) return true
  return false
}

function staleCutoffDays(kind) {
  switch (kind) {
    case 'decision': return 180
    case 'preference': return 120
    case 'constraint': return 180
    case 'fact': return 90
    default: return 120
  }
}

function decaySignalScore(score, lastSeen, kind = '') {
  const base = Number(score ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const cutoff =
    kind === 'language' || kind === 'tone' ? 180 :
    kind === 'cadence' ? 120 :
    90
  const penalty = Math.min(0.45, ageDays / cutoff * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

function normalizeTaskStatus(status, details = '') {
  const raw = String(status ?? '').trim().toLowerCase()
  if (raw === 'done' || raw === 'completed' || raw === 'cancelled' || raw === 'paused' || raw === 'in_progress' || raw === 'active') {
    if (raw === 'active' && /\b(done|completed|resolved|finished|merged|shipped)\b/.test(String(details).toLowerCase())) {
      return 'done'
    }
    return raw === 'completed' ? 'done' : raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  if (/\b(cancelled|canceled|dropped|abandoned)\b/.test(combined)) return 'cancelled'
  if (/\b(paused|blocked|waiting|hold)\b/.test(combined)) return 'paused'
  if (/\b(in progress|progress|ongoing)\b/.test(combined)) return 'in_progress'
  return 'active'
}

function normalizeFactSlot(slot) {
  const value = String(slot ?? '').trim()
  return value ? value : ''
}

function propositionKindForFact(factType, slot = '') {
  const normalizedSlot = normalizeFactSlot(slot)
  if (normalizedSlot) return normalizedSlot
  return normalizeFactType(factType) || 'fact'
}

function normalizeWorkstream(value) {
  const clean = String(value ?? '').trim().toLowerCase()
  if (!clean) return ''
  return clean
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function canonicalKeyTokens(text, maxTokens = 8) {
  return tokenizeMemoryText(text)
    .filter(token => token.length >= 2)
    .slice(0, Math.max(1, Number(maxTokens ?? 8)))
}

function deriveClaimKey(factType, slot = '', text = '', workstream = '') {
  const normalizedType = normalizeFactType(factType)
  const normalizedSlot = normalizeFactSlot(slot)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const normalizedWorkstream = normalizeWorkstream(workstream)
  const normalizedText = cleanMemoryText(text).toLowerCase()
  const canonicalValue = canonicalKeyTokens(normalizedText).join('-')
    || createHash('sha1').update(normalizedText).digest('hex').slice(0, 16)
  return [normalizedType, normalizedWorkstream, normalizedSlot || canonicalValue].filter(Boolean).join(':').slice(0, 160)
}

function deriveTaskKey(title = '', workstream = '') {
  const normalizedWorkstream = normalizeWorkstream(workstream)
  const normalizedTitle = cleanMemoryText(title).toLowerCase()
  const canonicalTitle = canonicalKeyTokens(normalizedTitle).join('-')
    || createHash('sha1').update(normalizedTitle).digest('hex').slice(0, 16)
  return [normalizedWorkstream || 'task', canonicalTitle].join(':').slice(0, 160)
}

function normalizeFactType(factType) {
  const value = String(factType ?? '').trim().toLowerCase()
  return ['preference', 'constraint', 'decision', 'fact'].includes(value) ? value : 'fact'
}

function normalizeSignalKind(kind) {
  const value = String(kind ?? '').trim().toLowerCase()
  return ['language', 'tone', 'time_pref', 'interest', 'cadence'].includes(value) ? value : 'interest'
}

function normalizeTaskPriority(priority) {
  const value = String(priority ?? 'normal').trim().toLowerCase()
  return ['low', 'normal', 'high'].includes(value) ? value : 'normal'
}

function normalizeTaskStage(stage, details = '') {
  const raw = String(stage ?? '').trim().toLowerCase()
  if (['planned', 'investigating', 'implementing', 'wired', 'verified', 'done'].includes(raw)) {
    return raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(wired|hooked|connected|registered|integrated)\b/.test(combined)) return 'wired'
  if (/\b(implementing|coding|building|refactoring|fixing)\b/.test(combined)) return 'implementing'
  if (/\b(investigating|researching|checking|exploring|surveying)\b/.test(combined)) return 'investigating'
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  return 'planned'
}

function normalizeEvidenceLevel(value, details = '') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (['claimed', 'implemented', 'verified'].includes(raw)) return raw
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(implemented|added|wired|registered|integrated|exists in code)\b/.test(combined)) return 'implemented'
  return 'claimed'
}

function taskStageRank(stage) {
  switch (String(stage ?? '').trim().toLowerCase()) {
    case 'planned': return 1
    case 'investigating': return 2
    case 'implementing': return 3
    case 'wired': return 4
    case 'verified': return 5
    case 'done': return 6
    default: return 0
  }
}

function taskEvidenceRank(level) {
  switch (String(level ?? '').trim().toLowerCase()) {
    case 'claimed': return 1
    case 'implemented': return 2
    case 'verified': return 3
    default: return 0
  }
}

function tokenizedWorkstream(value) {
  return normalizeWorkstream(value).split('-').filter(Boolean)
}


async function getIntentPrototypeVectors() {
  const currentModelId = getEmbeddingModelId()
  if (!intentPrototypeVectorsPromise || intentPrototypeVectorsModelId !== currentModelId) {
    intentPrototypeVectorsModelId = currentModelId
    intentPrototypeVectorsPromise = (async () => {
      const entries = []
      for (const [intent, phrases] of Object.entries(INTENT_PROTOTYPES)) {
        const vectors = await Promise.all(phrases.map(phrase => embedText(phrase)))
        entries.push([intent, vectors.filter(vector => Array.isArray(vector) && vector.length > 0)])
      }
      return new Map(entries)
    })()
  }
  return intentPrototypeVectorsPromise
}

export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.historyDir = join(dataDir, 'history')
    this.dbPath = join(dataDir, 'memory.sqlite')
    ensureDir(dirname(this.dbPath))
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true })
    this.vecEnabled = false
    this._loadVecExtension()
    this.init()
    this.backfillCanonicalKeys()
    if (this.needsDerivedIndexRebuild()) {
      this.rebuildDerivedIndexes()
    }
    this.syncEmbeddingMetadata()
  }

  _loadVecExtension() {
    if (!sqliteVec) return
    try {
      sqliteVec.load(this.db)
      this.vecEnabled = true
      let dims = getEmbeddingDims()
      try {
        const forcedDims = Number(process.env.CLAUDE2BOT_FORCE_VEC_DIMS ?? '0')
        if (forcedDims > 0) {
          dims = forcedDims
        } else {
          const hasMeta = this.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_meta'`).get()?.ok
          if (hasMeta) {
            const storedDims = Number(this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'embedding.vector_dims'`).get()?.value ?? '0')
            if (storedDims > 0) dims = storedDims
          }
        }
      } catch { /* ignore metadata lookup */ }
      // Check if vec_memory exists with different dimensions
      try {
        const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memory'`).get()
        if (existing?.sql && !existing.sql.includes(`float[${dims}]`)) {
          this.db.exec('DROP TABLE vec_memory')
          process.stderr.write(`[memory] vec_memory dimension changed, recreating with float[${dims}]\n`)
        }
      } catch {}
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${dims}])`)
    } catch (e) {
      process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}\n`)
    }
  }

  async switchEmbeddingModel(config = {}) {
    const oldModel = getEmbeddingModelId()
    configureEmbedding(config)
    await warmupEmbeddingProvider()
    const newModel = getEmbeddingModelId()
    if (oldModel === newModel) return { changed: false }

    process.stderr.write(`[memory] switching embedding model: ${oldModel} → ${newModel}\n`)
    const reset = this.resetDerivedMemoryForEmbeddingChange({ newModel })
    process.stderr.write(
      `[memory] embedding model changed; cleared derived memory and rebuilt ${reset.rebuiltCandidates} candidates for ${newModel}\n`,
    )
    return { changed: true, oldModel, newModel, reset }
  }

  resetDerivedMemoryForEmbeddingChange(options = {}) {
    const preservedEpisodes = Number(this.countEpisodes() ?? 0)
    this.db.exec(`
      DELETE FROM memory_candidates;
      DELETE FROM facts;
      DELETE FROM task_events;
      DELETE FROM tasks;
      DELETE FROM signals;
      DELETE FROM profiles;
      DELETE FROM interests;
      DELETE FROM propositions;
      DELETE FROM relations;
      DELETE FROM entity_links;
      DELETE FROM entities;
      DELETE FROM documents;
      DELETE FROM facts_fts;
      DELETE FROM tasks_fts;
      DELETE FROM signals_fts;
      DELETE FROM propositions_fts;
      DELETE FROM memory_vectors;
      DELETE FROM pending_embeds;
      DELETE FROM memory_meta;
    `)

    if (this.vecEnabled) {
      try {
        this.db.exec('DROP TABLE IF EXISTS vec_memory')
        const dims = getEmbeddingDims()
        this.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${dims}])`)
      } catch {}
    }

    this.clearHistoryOutputs()
    const rebuiltCandidates = this.rebuildCandidates()
    this.writeContextFile()
    this.syncEmbeddingMetadata({ reason: 'switch_embedding_model' })

    return {
      preservedEpisodes,
      rebuiltCandidates,
      historyCleared: true,
      targetModel: options.newModel ?? getEmbeddingModelId(),
    }
  }

  clearHistoryOutputs() {
    ensureDir(this.historyDir)
    const directFiles = ['context.md', 'identity.md', 'ongoing.md', 'lifetime.md', 'interests.json']
    for (const name of directFiles) {
      try { rmSync(join(this.historyDir, name), { force: true }) } catch {}
    }
    for (const dir of ['daily', 'weekly', 'monthly', 'yearly']) {
      try { rmSync(join(this.historyDir, dir), { recursive: true, force: true }) } catch {}
    }
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)

    // Migrate FTS tables from unicode61 to trigram for Korean support
    const ftsToMigrate = ['episodes_fts', 'facts_fts', 'tasks_fts', 'signals_fts']
    for (const table of ftsToMigrate) {
      try {
        const info = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (info?.sql && !info.sql.includes('trigram')) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`)
        }
      } catch { /* table may not exist yet */ }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'claude2bot',
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      DROP INDEX IF EXISTS idx_episodes_source_ref;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_ref ON episodes(source_ref);
      CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day_key, ts);
      CREATE INDEX IF NOT EXISTS idx_episodes_role ON episodes(role, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_day ON memory_candidates(day_key, status, score DESC);

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(kind, doc_key)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        fact_type TEXT NOT NULL,
        slot TEXT,
        claim_key TEXT,
        workstream TEXT,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mention_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(fact_type, text),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
        USING fts5(text, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL UNIQUE,
        task_key TEXT,
        details TEXT,
        workstream TEXT,
        stage TEXT NOT NULL DEFAULT 'planned',
        evidence_level TEXT NOT NULL DEFAULT 'claimed',
        status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'normal',
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts
        USING fts5(title, details, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        stage TEXT,
        evidence_level TEXT,
        status TEXT,
        note TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS interests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        score REAL NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(kind, value),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts
        USING fts5(kind, value, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'thing',
        description TEXT,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(name, entity_type)
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY,
        source_entity_id INTEGER NOT NULL REFERENCES entities(id),
        target_entity_id INTEGER NOT NULL REFERENCES entities(id),
        relation_type TEXT NOT NULL,
        description TEXT,
        confidence REAL DEFAULT 0.7,
        first_seen TEXT,
        last_seen TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source_episode_id INTEGER,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);

      CREATE TABLE IF NOT EXISTS entity_links (
        id INTEGER PRIMARY KEY,
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        linked_type TEXT NOT NULL,
        linked_id INTEGER NOT NULL,
        source_episode_id INTEGER,
        strength REAL NOT NULL DEFAULT 1,
        UNIQUE(entity_id, linked_type, linked_id),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON entity_links(entity_id, linked_type);
      CREATE INDEX IF NOT EXISTS idx_entity_links_linked ON entity_links(linked_type, linked_id);

      CREATE TABLE IF NOT EXISTS propositions (
        id INTEGER PRIMARY KEY,
        subject_key TEXT NOT NULL,
        proposition_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        occurred_on TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        source_fact_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mention_count INTEGER NOT NULL DEFAULT 1,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        superseded_by INTEGER REFERENCES propositions(id),
        UNIQUE(subject_key, proposition_kind, text),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL,
        FOREIGN KEY(source_fact_id) REFERENCES facts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_propositions_subject ON propositions(subject_key, proposition_kind, status);
      CREATE INDEX IF NOT EXISTS idx_propositions_fact ON propositions(source_fact_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts
        USING fts5(text, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS pending_embeds (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(entity_type, entity_id, model)
      );
    `)

    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN slot TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN claim_key TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN superseded_by INTEGER REFERENCES facts(id);`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN task_key TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'planned';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'claimed';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 1;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`)
    } catch { /* already present */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_slot ON facts(slot);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_claim_key ON facts(claim_key);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key);`)

    this.insertEpisodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO episodes (
        ts, day_key, backend, channel_id, user_id, user_name, session_id,
        role, kind, content, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertEpisodeFtsStmt = this.db.prepare(`
      INSERT INTO episodes_fts(rowid, content) VALUES (?, ?)
    `)
    this.getEpisodeBySourceStmt = this.db.prepare(`
      SELECT id FROM episodes WHERE source_ref = ?
    `)
    this.insertCandidateStmt = this.db.prepare(`
      INSERT INTO memory_candidates (episode_id, ts, day_key, role, content, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.clearCandidatesStmt = this.db.prepare(`DELETE FROM memory_candidates`)
    this.clearFactsStmt = this.db.prepare(`DELETE FROM facts`)
    this.clearTasksStmt = this.db.prepare(`DELETE FROM tasks`)
    this.clearSignalsStmt = this.db.prepare(`DELETE FROM signals`)
    this.clearPropositionsStmt = this.db.prepare(`DELETE FROM propositions`)
    this.clearEntityLinksStmt = this.db.prepare(`DELETE FROM entity_links`)
    this.clearFactsFtsStmt = this.db.prepare(`DELETE FROM facts_fts`)
    this.clearTasksFtsStmt = this.db.prepare(`DELETE FROM tasks_fts`)
    this.clearSignalsFtsStmt = this.db.prepare(`DELETE FROM signals_fts`)
    this.clearPropositionsFtsStmt = this.db.prepare(`DELETE FROM propositions_fts`)
    this.clearVectorsStmt = this.db.prepare(`DELETE FROM memory_vectors`)
    this.getMetaStmt = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`)
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO memory_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.hasVectorModelStmt = this.db.prepare(`
      SELECT 1 AS ok
      FROM memory_vectors
      WHERE model = ?
      LIMIT 1
    `)
    this.upsertDocumentStmt = this.db.prepare(`
      INSERT INTO documents (kind, doc_key, content, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(kind, doc_key) DO UPDATE SET
        content = excluded.content,
        updated_at = unixepoch()
    `)
    this.upsertProfileStmt = this.db.prepare(`
      INSERT INTO profiles (key, value, confidence, first_seen, last_seen, source_episode_id, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        mention_count = profiles.mention_count + 1,
        value = CASE WHEN profiles.mention_count + 1 >= 3 THEN excluded.value ELSE profiles.value END,
        confidence = CASE WHEN profiles.mention_count + 1 >= 3 THEN MAX(profiles.confidence, excluded.confidence) ELSE profiles.confidence END,
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, profiles.source_episode_id)
    `)
    this.bumpProfileRetrievalStmt = this.db.prepare(`
      UPDATE profiles
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE key = ?
    `)
    this.upsertFactStmt = this.db.prepare(`
      INSERT INTO facts (fact_type, slot, claim_key, workstream, text, confidence, first_seen, last_seen, source_episode_id, status, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
      ON CONFLICT(fact_type, text) DO UPDATE SET
        slot = COALESCE(excluded.slot, facts.slot),
        claim_key = COALESCE(excluded.claim_key, facts.claim_key),
        workstream = COALESCE(excluded.workstream, facts.workstream),
        confidence = MAX(facts.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, facts.source_episode_id),
        status = 'active',
        mention_count = facts.mention_count + 1
    `)
    this.getFactRowByClaimKeyStmt = this.db.prepare(`
      SELECT id, fact_type, slot, claim_key, workstream, text, confidence
      FROM facts
      WHERE fact_type = ? AND claim_key = ? AND status = 'active'
      ORDER BY confidence DESC, mention_count DESC, last_seen DESC
      LIMIT 1
    `)
    this.updateFactByIdStmt = this.db.prepare(`
      UPDATE facts
      SET slot = ?, claim_key = ?, workstream = ?, text = ?, confidence = ?, last_seen = ?,
          source_episode_id = COALESCE(?, source_episode_id), status = 'active',
          mention_count = mention_count + 1
      WHERE id = ?
    `)
    this.bumpFactSeenStmt = this.db.prepare(`
      UPDATE facts
      SET last_seen = ?, mention_count = mention_count + 1
      WHERE id = ?
    `)
    this.staleFactSlotStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE slot = ?
        AND text != ?
        AND status = 'active'
    `)
    this.getFactIdStmt = this.db.prepare(`
      SELECT id FROM facts WHERE fact_type = ? AND text = ?
    `)
    this.getFactIdByClaimKeyStmt = this.db.prepare(`
      SELECT id
      FROM facts
      WHERE fact_type = ? AND claim_key = ? AND status = 'active'
      ORDER BY confidence DESC, mention_count DESC, last_seen DESC
      LIMIT 1
    `)
    this.deleteFactFtsStmt = this.db.prepare(`DELETE FROM facts_fts WHERE rowid = ?`)
    this.insertFactFtsStmt = this.db.prepare(`INSERT INTO facts_fts(rowid, text) VALUES (?, ?)`)
    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (title, task_key, details, workstream, stage, evidence_level, status, priority, confidence, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(title) DO UPDATE SET
        task_key = COALESCE(excluded.task_key, tasks.task_key),
        details = excluded.details,
        workstream = COALESCE(excluded.workstream, tasks.workstream),
        stage = excluded.stage,
        evidence_level = excluded.evidence_level,
        status = excluded.status,
        priority = excluded.priority,
        confidence = MAX(tasks.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, tasks.source_episode_id)
    `)
    this.getTaskRowByKeyStmt = this.db.prepare(`
      SELECT id, title, status, stage, evidence_level
      FROM tasks
      WHERE task_key = ?
      ORDER BY confidence DESC, last_seen DESC
      LIMIT 1
    `)
    this.updateTaskByIdStmt = this.db.prepare(`
      UPDATE tasks
      SET title = ?, task_key = ?, details = ?, workstream = ?, stage = ?, evidence_level = ?,
          status = ?, priority = ?, confidence = MAX(confidence, ?), last_seen = ?,
          source_episode_id = COALESCE(?, source_episode_id)
      WHERE id = ?
    `)
    this.getTaskRowStmt = this.db.prepare(`
      SELECT id, status, stage, evidence_level FROM tasks WHERE title = ?
    `)
    this.getTaskIdStmt = this.db.prepare(`
      SELECT id FROM tasks WHERE title = ?
    `)
    this.getTaskIdByKeyStmt = this.db.prepare(`
      SELECT id
      FROM tasks
      WHERE task_key = ?
      ORDER BY confidence DESC, last_seen DESC
      LIMIT 1
    `)
    this.deleteTaskFtsStmt = this.db.prepare(`DELETE FROM tasks_fts WHERE rowid = ?`)
    this.insertTaskFtsStmt = this.db.prepare(`INSERT INTO tasks_fts(rowid, title, details) VALUES (?, ?, ?)`)
    this.insertTaskEventStmt = this.db.prepare(`
      INSERT INTO task_events (task_id, ts, event_kind, stage, evidence_level, status, note, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.getTaskEventsStmt = this.db.prepare(`
      SELECT ts, event_kind, stage, evidence_level, status, note
      FROM task_events
      WHERE task_id = ?
      ORDER BY ts ASC, id ASC
    `)
    this.updateTaskProjectionStmt = this.db.prepare(`
      UPDATE tasks
      SET stage = ?, evidence_level = ?, status = ?
      WHERE id = ?
    `)
    this.clearInterestsStmt = this.db.prepare(`DELETE FROM interests`)
    this.insertInterestStmt = this.db.prepare(`
      INSERT INTO interests (name, score, count, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        score = excluded.score,
        count = excluded.count,
        last_seen = excluded.last_seen
    `)
    this.upsertSignalStmt = this.db.prepare(`
      INSERT INTO signals (kind, value, score, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, value) DO UPDATE SET
        score = MIN(1.5, MAX(signals.score, excluded.score) + 0.05),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, signals.source_episode_id)
    `)
    this.getSignalIdStmt = this.db.prepare(`
      SELECT id FROM signals WHERE kind = ? AND value = ?
    `)
    this.deleteSignalFtsStmt = this.db.prepare(`DELETE FROM signals_fts WHERE rowid = ?`)
    this.insertSignalFtsStmt = this.db.prepare(`INSERT INTO signals_fts(rowid, kind, value) VALUES (?, ?, ?)`)
    this.upsertEntityLinkStmt = this.db.prepare(`
      INSERT INTO entity_links (entity_id, linked_type, linked_id, source_episode_id, strength)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_id, linked_type, linked_id) DO UPDATE SET
        source_episode_id = COALESCE(excluded.source_episode_id, entity_links.source_episode_id),
        strength = MAX(entity_links.strength, excluded.strength)
    `)
    this.listEntityLinksStmt = this.db.prepare(`
      SELECT entity_id, linked_type, linked_id, strength
      FROM entity_links
      WHERE entity_id = ?
      ORDER BY strength DESC, linked_type ASC, linked_id ASC
    `)
    this.upsertPropositionStmt = this.db.prepare(`
      INSERT INTO propositions (
        subject_key, proposition_kind, text, occurred_on, confidence, first_seen, last_seen,
        source_episode_id, source_fact_id, status, mention_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
      ON CONFLICT(subject_key, proposition_kind, text) DO UPDATE SET
        confidence = MAX(propositions.confidence, excluded.confidence),
        occurred_on = COALESCE(excluded.occurred_on, propositions.occurred_on),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, propositions.source_episode_id),
        source_fact_id = COALESCE(excluded.source_fact_id, propositions.source_fact_id),
        status = 'active',
        mention_count = propositions.mention_count + 1
    `)
    this.findPropositionStmt = this.db.prepare(`
      SELECT id, subject_key, proposition_kind, text, occurred_on, confidence
      FROM propositions
      WHERE subject_key = ? AND proposition_kind = ? AND text = ?
    `)
    this.listSiblingPropositionsStmt = this.db.prepare(`
      SELECT id, text, occurred_on
      FROM propositions
      WHERE subject_key = ?
        AND proposition_kind = ?
        AND status = 'active'
        AND id != ?
    `)
    this.markPropositionSupersededStmt = this.db.prepare(`
      UPDATE propositions
      SET status = 'superseded',
          superseded_by = ?,
          last_seen = ?
      WHERE id = ?
    `)
    this.bumpPropositionRetrievalStmt = this.db.prepare(`
      UPDATE propositions
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.deletePropositionFtsStmt = this.db.prepare(`DELETE FROM propositions_fts WHERE rowid = ?`)
    this.insertPropositionFtsStmt = this.db.prepare(`INSERT INTO propositions_fts(rowid, text) VALUES (?, ?)`)
    this.markFactsStaleStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE status = 'active'
        AND fact_type = ?
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > ?
        AND mention_count < 3
    `)
    this.reviveFactsStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'active'
      WHERE status = 'stale'
        AND fact_type = ?
        AND text = ?
    `)
    this.markTasksStaleStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'stale'
      WHERE status IN ('active', 'in_progress', 'paused')
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > 45
        AND confidence < 0.75
    `)
    this.bumpFactRetrievalStmt = this.db.prepare(`
      UPDATE facts
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpTaskRetrievalStmt = this.db.prepare(`
      UPDATE tasks
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpSignalRetrievalStmt = this.db.prepare(`
      UPDATE signals
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.upsertVectorStmt = this.db.prepare(`
      INSERT INTO memory_vectors (entity_type, entity_id, model, dims, vector_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = unixepoch()
    `)
    this.getVectorStmt = this.db.prepare(`
      SELECT entity_type, entity_id, model, dims, vector_json, content_hash
      FROM memory_vectors
      WHERE entity_type = ? AND entity_id = ? AND model = ?
    `)
    this.listDenseFactRowsStmt = this.db.prepare(`
      SELECT 'fact' AS type, f.fact_type AS subtype, f.id AS entity_id, f.workstream AS workstream, f.text AS content,
             unixepoch(f.last_seen) AS updated_at, f.retrieval_count AS retrieval_count,
             f.confidence AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN facts f ON f.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = f.source_episode_id
      WHERE mv.entity_type = 'fact'
        AND mv.model = ?
        AND f.status = 'active'
    `)
    this.listDenseTaskRowsStmt = this.db.prepare(`
      SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id, t.workstream AS workstream,
             trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
             unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
             t.confidence AS quality_score,
             t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN tasks t ON t.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = t.source_episode_id
      WHERE mv.entity_type = 'task'
        AND mv.model = ?
        AND t.status IN ('active', 'in_progress', 'paused')
    `)
    this.listDenseTaskRowsWithDoneStmt = this.db.prepare(`
      SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id, t.workstream AS workstream,
             trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
             unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
             t.confidence AS quality_score,
             t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN tasks t ON t.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = t.source_episode_id
      WHERE mv.entity_type = 'task'
        AND mv.model = ?
        AND t.status IN ('active', 'in_progress', 'paused', 'done')
    `)
    this.listDenseSignalRowsStmt = this.db.prepare(`
      SELECT 'signal' AS type, s.kind AS subtype, s.id AS entity_id, s.value AS content,
             unixepoch(s.last_seen) AS updated_at, s.retrieval_count AS retrieval_count,
             s.score AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN signals s ON s.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = s.source_episode_id
      WHERE mv.entity_type = 'signal'
        AND mv.model = ?
    `)
    this.listDensePropositionRowsStmt = this.db.prepare(`
      SELECT 'proposition' AS type, p.proposition_kind AS subtype, p.id AS entity_id, p.text AS content,
             unixepoch(p.last_seen) AS updated_at, p.retrieval_count AS retrieval_count,
             p.confidence AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN propositions p ON p.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = p.source_episode_id
      WHERE mv.entity_type = 'proposition'
        AND mv.model = ?
        AND p.status = 'active'
    `)
    this.listDenseEpisodeRowsStmt = this.db.prepare(`
      SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content AS content,
             e.created_at AS updated_at, 0 AS retrieval_count,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN episodes e ON e.id = mv.entity_id
      WHERE mv.entity_type = 'episode'
        AND mv.model = ?
        AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
    `)
    this.listDenseEntityRowsStmt = this.db.prepare(`
      SELECT 'entity' AS type, en.entity_type AS subtype, en.id AS entity_id,
             trim(en.name || CASE WHEN en.description IS NOT NULL AND en.description != '' THEN ' — ' || en.description ELSE '' END) AS content,
             unixepoch(en.last_seen) AS updated_at, 0 AS retrieval_count,
             NULL AS source_ref, NULL AS source_ts, NULL AS source_kind, NULL AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN entities en ON en.id = mv.entity_id
      WHERE mv.entity_type = 'entity'
        AND mv.model = ?
    `)
    this.listDenseRelationRowsStmt = this.db.prepare(`
      SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
             trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
             unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
             NULL AS source_ref, NULL AS source_ts, NULL AS source_kind, NULL AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN relations r ON r.id = mv.entity_id
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE mv.entity_type = 'relation'
        AND mv.model = ?
        AND r.status = 'active'
    `)
  }

  getMetaValue(key, fallback = null) {
    const row = this.getMetaStmt.get(key)
    return row?.value ?? fallback
  }

  getRetrievalTuning() {
    const configPath = join(this.dataDir, 'config.json')
    try {
      const mtimeMs = statSync(configPath).mtimeMs
      if (this._retrievalTuningCache?.mtimeMs === mtimeMs) return this._retrievalTuningCache.value
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      const value = mergeMemoryTuning(raw?.retrieval ?? {})
      this._retrievalTuningCache = { mtimeMs, value }
      return value
    } catch {
      if (this._retrievalTuningCache?.value) return this._retrievalTuningCache.value
      const value = mergeMemoryTuning()
      this._retrievalTuningCache = { mtimeMs: 0, value }
      return value
    }
  }

  setMetaValue(key, value) {
    const serialized =
      typeof value === 'string'
        ? value
        : JSON.stringify(value)
    this.upsertMetaStmt.run(key, serialized)
  }

  syncEmbeddingMetadata(extra = {}) {
    this.setMetaValue('embedding.current_model', getEmbeddingModelId())
    this.setMetaValue('embedding.current_dims', String(getEmbeddingDims()))
    this.setMetaValue('embedding.index_version', '2')
    this.setMetaValue('embedding.updated_at', new Date().toISOString())
    if (extra.vectorModel) this.setMetaValue('embedding.vector_model', extra.vectorModel)
    if (extra.vectorDims) this.setMetaValue('embedding.vector_dims', String(extra.vectorDims))
    if (extra.reason) this.setMetaValue('embedding.last_reason', extra.reason)
    if (extra.reindexRequired != null) this.setMetaValue('embedding.reindex_required', extra.reindexRequired ? '1' : '0')
    if (extra.reindexReason) this.setMetaValue('embedding.reindex_reason', extra.reindexReason)
    if (extra.reindexCompleted) {
      this.setMetaValue('embedding.reindex_required', '0')
      this.setMetaValue('embedding.reindex_reason', '')
    }
  }

  noteVectorWrite(model, dims) {
    const switchEvent = consumeProviderSwitchEvent()
    this.syncEmbeddingMetadata({
      vectorModel: model,
      vectorDims: dims,
      reason: switchEvent ? `vector_write_after_${switchEvent.phase}_switch` : 'vector_write',
      reindexRequired: switchEvent ? 1 : 0,
      reindexReason: switchEvent
        ? `${switchEvent.previousModelId} -> ${switchEvent.currentModelId} (${switchEvent.phase}: ${switchEvent.reason})`
        : '',
    })
  }

  backfillCanonicalKeys() {
    const factRows = this.db.prepare(`
      SELECT id, fact_type, slot, workstream, text
      FROM facts
      WHERE claim_key IS NULL OR claim_key = ''
    `).all()
    for (const row of factRows) {
      const claimKey = deriveClaimKey(row.fact_type, row.slot, row.text, row.workstream)
      this.db.prepare(`UPDATE facts SET claim_key = ? WHERE id = ?`).run(claimKey, row.id)
    }

    const taskRows = this.db.prepare(`
      SELECT id, title, workstream
      FROM tasks
      WHERE task_key IS NULL OR task_key = ''
    `).all()
    for (const row of taskRows) {
      const taskKey = deriveTaskKey(row.title, row.workstream)
      this.db.prepare(`UPDATE tasks SET task_key = ? WHERE id = ?`).run(taskKey, row.id)
    }
  }

  deriveSubjectKey(text, propositionKind = 'fact') {
    const clean = cleanMemoryText(text)
    if (!clean) return propositionKind
    try {
      const entities = this.db.prepare(`
        SELECT name
        FROM entities
        ORDER BY length(name) DESC, id ASC
      `).all()
      for (const entity of entities) {
        if (entity?.name && clean.toLowerCase().includes(String(entity.name).toLowerCase())) {
          return String(entity.name)
        }
      }
    } catch { /* ignore */ }
    const tokens = propositionSubjectTokens(clean)
    if (tokens.length === 0) return propositionKind
    return tokens.slice(0, 2).join('-')
  }

  upsertPropositions(items = [], seenAt = null, sourceEpisodeId = null, sourceFactId = null) {
    const seenKeys = new Set()
    for (const item of items) {
      const text = cleanMemoryText(item?.text)
      const propositionKind = normalizeFactSlot(item?.propositionKind) || 'fact'
      if (!text) continue
      const subjectKey = normalizeWorkstream(item?.subjectKey) || normalizeWorkstream(this.deriveSubjectKey(text, propositionKind)) || propositionKind
      const occurredOn = item?.occurredOn ?? extractExplicitDate(text) ?? (seenAt ? String(seenAt).slice(0, 10) : null)
      const confidence = Number(item?.confidence ?? 0.6)
      const dedupeKey = `${subjectKey}:${propositionKind}:${text}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      this.upsertPropositionStmt.run(
        subjectKey,
        propositionKind,
        text,
        occurredOn,
        confidence,
        seenAt,
        seenAt,
        sourceEpisodeId,
        sourceFactId,
      )
      const row = this.findPropositionStmt.get(subjectKey, propositionKind, text)
      if (!row?.id) continue
      this.deletePropositionFtsStmt.run(row.id)
      this.insertPropositionFtsStmt.run(row.id, text)
      const siblings = this.listSiblingPropositionsStmt.all(subjectKey, propositionKind, row.id)
      for (const sibling of siblings) {
        const siblingDate = sibling?.occurred_on ? new Date(String(sibling.occurred_on)).getTime() : 0
        const rowDate = occurredOn ? new Date(String(occurredOn)).getTime() : 0
        const lexicalOverlap = (() => {
          const left = new Set(tokenizeMemoryText(text))
          const right = new Set(tokenizeMemoryText(String(sibling?.text ?? '')))
          const overlap = [...left].filter(token => right.has(token)).length
          return left.size > 0 ? overlap / left.size : 0
        })()
        if (String(sibling?.text ?? '') === text) continue
        if (rowDate && siblingDate && rowDate < siblingDate) continue
        if (lexicalOverlap < 0.35) continue
        this.markPropositionSupersededStmt.run(row.id, seenAt ?? new Date().toISOString(), sibling.id)
      }
      this.linkMemoryToEntities(text, 'proposition', row.id, sourceEpisodeId)
    }
  }

  linkMemoryToEntities(text, linkedType, linkedId, sourceEpisodeId = null) {
    const clean = cleanMemoryText(text)
    if (!clean || !linkedType || !Number.isFinite(Number(linkedId))) return
    let entities = []
    try {
      entities = this.db.prepare(`
        SELECT id, name
        FROM entities
        ORDER BY length(name) DESC, id ASC
      `).all()
    } catch {
      return
    }
    const lowered = clean.toLowerCase()
    for (const entity of entities) {
      const name = String(entity?.name ?? '').trim()
      if (!name) continue
      if (!lowered.includes(name.toLowerCase())) continue
      const strength = Math.min(1.5, Math.max(0.6, name.length / 20))
      this.upsertEntityLinkStmt.run(entity.id, linkedType, Number(linkedId), sourceEpisodeId, strength)
    }
  }

  rebuildEntityLinks() {
    this.clearEntityLinksStmt.run()

    const factRows = this.db.prepare(`SELECT id, text, source_episode_id FROM facts WHERE status = 'active'`).all()
    for (const row of factRows) this.linkMemoryToEntities(row.text, 'fact', row.id, row.source_episode_id)

    const taskRows = this.db.prepare(`
      SELECT id,
             trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content,
             source_episode_id
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused', 'done')
    `).all()
    for (const row of taskRows) this.linkMemoryToEntities(row.content, 'task', row.id, row.source_episode_id)

    const propositionRows = this.db.prepare(`SELECT id, text, source_episode_id FROM propositions WHERE status = 'active'`).all()
    for (const row of propositionRows) this.linkMemoryToEntities(row.text, 'proposition', row.id, row.source_episode_id)

    const episodeRows = this.db.prepare(`
      SELECT id, content
      FROM episodes
      WHERE role = 'user'
        AND kind = 'message'
    `).all()
    for (const row of episodeRows) this.linkMemoryToEntities(row.content, 'episode', row.id, row.id)
  }

  resolveQueryEntityScope(query = '') {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    try {
      const entities = this.db.prepare(`
        SELECT id, name, entity_type, description, source_episode_id
        FROM entities
        ORDER BY length(name) DESC, last_seen DESC, id ASC
      `).all()
      const lowered = clean.toLowerCase()
      const rows = entities.filter(entity => {
        const name = String(entity?.name ?? '').trim().toLowerCase()
        if (!name) return false
        return lowered.includes(name)
      }).slice(0, 8)
      const seen = new Set()
      return rows.filter(row => {
        if (seen.has(row.id)) return false
        seen.add(row.id)
        return true
      })
    } catch {
      return []
    }
  }

  getEntityScopedResults(queryEntities = [], limit = 6, options = {}) {
    const results = []
    const seen = new Set()
    if (Boolean(options.preferRelations) && queryEntities.length >= 2) {
      const entityIds = queryEntities.map(entity => Number(entity.id)).filter(Number.isFinite)
      const relations = this.db.prepare(`
        SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
               trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
               unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
               r.confidence AS quality_score, r.source_episode_id AS source_episode_id,
               ep.kind AS source_kind, ep.backend AS source_backend
        FROM relations r
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        LEFT JOIN episodes ep ON ep.id = r.source_episode_id
        WHERE r.status = 'active'
          AND r.source_entity_id IN (${entityIds.map(() => '?').join(', ')})
          AND r.target_entity_id IN (${entityIds.map(() => '?').join(', ')})
        ORDER BY r.confidence DESC, r.last_seen DESC
        LIMIT ?
      `).all(...entityIds, ...entityIds, Math.max(2, limit))
      for (const relation of relations) {
        const key = `${relation.type}:${relation.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ ...relation, score: SCOPED_LANE_PRIOR.graph_multi_relation })
      }
    }
    if (queryEntities.length === 1) {
      const entityId = Number(queryEntities[0].id)
      const relations = this.db.prepare(`
        SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
               trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
               unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
               r.confidence AS quality_score, r.source_episode_id AS source_episode_id,
               ep.kind AS source_kind, ep.backend AS source_backend
        FROM relations r
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        LEFT JOIN episodes ep ON ep.id = r.source_episode_id
        WHERE r.status = 'active'
          AND (r.source_entity_id = ? OR r.target_entity_id = ?)
        ORDER BY r.confidence DESC, r.last_seen DESC
        LIMIT ?
      `).all(entityId, entityId, Math.max(2, limit))
      for (const relation of relations) {
        const key = `${relation.type}:${relation.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ ...relation, score: SCOPED_LANE_PRIOR.graph_single_relation })
      }
    }
    for (const entity of queryEntities) {
      const links = this.listEntityLinksStmt.all(entity.id).slice(0, Math.max(3, limit))
      for (const link of links) {
        let row = null
        if (link.linked_type === 'fact') row = this._getEntityMeta('fact', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'task') row = this._getEntityMeta('task', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'proposition') row = this._getEntityMeta('proposition', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'episode') row = this._getEntityMeta('episode', link.linked_id, getEmbeddingModelId())
        if (!row) continue
        const key = `${row.type}:${row.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          ...row,
          score: SCOPED_LANE_PRIOR.graph_entity_link,
          scoped_entity_id: entity.id,
          scoped_entity_name: entity.name,
        })
        if (results.length >= limit) return results
      }
    }
    return results
  }

  getRuleScopedResults(query = '', limit = 6) {
    const clean = cleanMemoryText(query)
    if (!clean || !isRuleQuery(clean)) return []
    const tokens = propositionSubjectTokens(clean).slice(0, 8)
    if (tokens.length === 0) return []
    const patterns = tokens.map(token => `%${token}%`)
    const results = []
    try {
      results.push(...this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, retrieval_count,
               confidence AS quality_score, source_episode_id
        FROM facts
        WHERE status = 'active'
          AND fact_type = 'constraint'
          AND (${patterns.map(() => 'text LIKE ?').join(' OR ')})
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...patterns, Math.max(3, limit)))
    } catch { /* ignore */ }
    try {
      results.push(...this.db.prepare(`
        SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, retrieval_count,
               confidence AS quality_score, source_episode_id, source_fact_id
        FROM propositions
        WHERE status = 'active'
          AND (${patterns.map(() => 'text LIKE ?').join(' OR ')})
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...patterns, Math.max(3, limit)))
    } catch { /* ignore */ }
    return results
      .sort((left, right) => Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0))
      .slice(0, limit)
      .map(item => ({ ...item, score: SCOPED_LANE_PRIOR.rule }))
  }

  /**
   * Retrieve a stored vector from memory_vectors, or compute and store it.
   * @param {string} entityType - 'fact', 'task', 'signal', 'episode'
   * @param {number} entityId - row id
   * @param {string} text - text to embed if no stored vector found
   * @returns {number[]} embedding vector
   */
  async getStoredVector(entityType, entityId, text) {
    const lookupModel = getEmbeddingModelId()
    const existing = this.getVectorStmt.get(entityType, entityId, lookupModel)
    if (existing?.vector_json) {
      try {
        const parsed = JSON.parse(existing.vector_json)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      } catch { /* fall through to embed */ }
    }
    const vector = await embedText(String(text).slice(0, 320))
    if (Array.isArray(vector) && vector.length > 0) {
      const activeModel = getEmbeddingModelId()
      const contentHash = hashEmbeddingInput(text)
      this.upsertVectorStmt.run(entityType, entityId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(entityType, entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
    }
    return vector
  }

  rebuildDerivedIndexes() {
    this.clearFactsFtsStmt.run()
    this.clearTasksFtsStmt.run()
    this.clearSignalsFtsStmt.run()
    this.clearPropositionsFtsStmt.run()

    const facts = this.db.prepare(`SELECT id, text FROM facts`).all()
    for (const row of facts) {
      try { this.deleteFactFtsStmt.run(row.id) } catch (error) { logIgnoredError('rebuild facts fts delete', error) }
      try { this.insertFactFtsStmt.run(row.id, row.text) } catch (error) { logIgnoredError('rebuild facts fts insert', error) }
    }

    const tasks = this.db.prepare(`SELECT id, title, details FROM tasks`).all()
    for (const row of tasks) {
      try { this.deleteTaskFtsStmt.run(row.id) } catch (error) { logIgnoredError('rebuild tasks fts delete', error) }
      try { this.insertTaskFtsStmt.run(row.id, row.title, row.details ?? '') } catch (error) { logIgnoredError('rebuild tasks fts insert', error) }
    }

    const signals = this.db.prepare(`SELECT id, kind, value FROM signals`).all()
    for (const row of signals) {
      try {
        this.insertSignalFtsStmt.run(row.id, row.kind, row.value)
      } catch (error) { logIgnoredError('rebuild signals fts insert', error) }
    }

    const propositions = this.db.prepare(`SELECT id, text FROM propositions WHERE status = 'active'`).all()
    for (const row of propositions) {
      try { this.deletePropositionFtsStmt.run(row.id) } catch (error) { logIgnoredError('rebuild propositions fts delete', error) }
      try { this.insertPropositionFtsStmt.run(row.id, row.text) } catch (error) { logIgnoredError('rebuild propositions fts insert', error) }
    }

  }

  needsDerivedIndexRebuild() {
    try {
      const checks = [
        { base: `SELECT count(*) AS n FROM facts`, fts: `SELECT count(*) AS n FROM facts_fts` },
        { base: `SELECT count(*) AS n FROM tasks`, fts: `SELECT count(*) AS n FROM tasks_fts` },
        { base: `SELECT count(*) AS n FROM signals`, fts: `SELECT count(*) AS n FROM signals_fts` },
        { base: `SELECT count(*) AS n FROM propositions WHERE status = 'active'`, fts: `SELECT count(*) AS n FROM propositions_fts` },
      ]
      for (const check of checks) {
        const baseCount = Number(this.db.prepare(check.base).get()?.n ?? 0)
        const ftsCount = Number(this.db.prepare(check.fts).get()?.n ?? 0)
        if (baseCount !== ftsCount) return true
      }
      return false
    } catch (error) {
      logIgnoredError('needsDerivedIndexRebuild', error)
      return true
    }
  }

  appendEpisode(entry) {
    const clean = cleanMemoryText(entry.content)
    if (!clean) return null
    const ts = entry.ts || new Date().toISOString()
    const dayKey = ts.slice(0, 10)
    const sourceRef = entry.sourceRef || null
    const episodeKind = entry.kind || 'message'
    this.insertEpisodeStmt.run(
      ts,
      dayKey,
      entry.backend || 'claude2bot',
      entry.channelId || null,
      entry.userId || null,
      entry.userName || null,
      entry.sessionId || null,
      entry.role,
      episodeKind,
      clean,
      sourceRef,
    )

    const episodeId = sourceRef ? this.getEpisodeBySourceStmt.get(sourceRef)?.id : null
    const finalEpisodeId = episodeId ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id
    if (finalEpisodeId) {
      if (episodeKind === 'message' || episodeKind === 'turn') {
        try {
          this.insertEpisodeFtsStmt.run(finalEpisodeId, clean)
        } catch { /* duplicate rowid import */ }
      }
      const shouldCandidate =
        entry.role === 'user' &&
        episodeKind === 'message'
      if (shouldCandidate) {
        insertCandidateUnits(this.insertCandidateStmt, finalEpisodeId, ts, dayKey, entry.role, clean)
      }

      // Inline embedding: immediately make this episode searchable via dense search
      if (shouldCandidate && clean.length >= 10 && clean.length <= 500 && !looksLowSignal(clean)) {
        this._embedEpisodeAsync(finalEpisodeId, clean)
      }
    }
    return finalEpisodeId ?? null
  }

  _embedEpisodeAsync(episodeId, content) {
    const lookupModel = getEmbeddingModelId()
    const contentHash = hashEmbeddingInput(content)
    const existing = this.getVectorStmt.get('episode', episodeId, lookupModel)
    if (existing?.content_hash === contentHash) return
    // Persist to DB queue for crash recovery
    try {
      this.db.prepare('INSERT OR IGNORE INTO pending_embeds (entity_type, entity_id, content) VALUES (?, ?, ?)').run('episode', episodeId, content.slice(0, 320))
    } catch {}
    // Process asynchronously
    const task = async () => {
      const vector = await embedText(content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) return
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run('episode', episodeId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable('episode', episodeId, vector)
      this.noteVectorWrite(activeModel, vector.length)
      try { this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run('episode', episodeId) } catch {}
    }
    if (!this._embedQueue) this._embedQueue = Promise.resolve()
    this._embedQueue = this._embedQueue.then(task).catch(() => {})
  }

  async processPendingEmbeds() {
    const pending = this.db.prepare('SELECT entity_type, entity_id, content FROM pending_embeds ORDER BY id LIMIT 50').all()
    if (pending.length === 0) return 0
    let processed = 0
    for (const item of pending) {
      const vector = await embedText(item.content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) continue
      const activeModel = getEmbeddingModelId()
      const contentHash = hashEmbeddingInput(item.content)
      this.upsertVectorStmt.run(item.entity_type, item.entity_id, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(item.entity_type, item.entity_id, vector)
      this.noteVectorWrite(activeModel, vector.length)
      this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run(item.entity_type, item.entity_id)
      processed += 1
    }
    if (processed > 0) process.stderr.write(`[memory] recovered ${processed} pending embeds\n`)
    return processed
  }

  ingestTranscriptFile(transcriptPath) {
    if (!existsSync(transcriptPath)) return 0
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
    let count = 0
    let index = 0
    for (const line of lines) {
      index += 1
      try {
        const parsed = JSON.parse(line)
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant') continue
        const text = firstTextContent(parsed.message?.content)
        if (!text.trim()) continue
        const clean = cleanMemoryText(text)
        if (!clean || clean.includes('[Request interrupted by user]')) continue
        if (isTranscriptQuarantineContent(clean)) continue
        const ts = parsed.timestamp ?? parsed.ts ?? new Date(statSync(transcriptPath).mtimeMs).toISOString()
        const sessionId = parsed.sessionId ?? ''
        const sourceRef = `transcript:${sessionId || resolve(transcriptPath)}:${index}:${role}`
        const id = this.appendEpisode({
          ts,
          backend: 'claude-session',
          channelId: null,
          userId: role === 'user' ? 'session:user' : 'session:assistant',
          userName: role,
          sessionId: sessionId || null,
          role,
          kind: 'transcript',
          content: clean,
          sourceRef,
        })
        if (id) count += 1
      } catch { /* skip malformed lines */ }
    }
    return count
  }

  ingestTranscriptFiles(paths) {
    let total = 0
    for (const filePath of paths) {
      total += this.ingestTranscriptFile(filePath)
    }
    return total
  }

  getEpisodesForDate(dayKey, options = {}) {
    const includeTranscripts = Boolean(options.includeTranscripts)
    return this.db.prepare(`
      SELECT id, ts, role, content
      FROM episodes
      WHERE day_key = ?
        AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
      ORDER BY ts, id
    `).all(dayKey)
  }

  getEpisodeDayKey(episodeId) {
    return this.db.prepare(`
      SELECT day_key
      FROM episodes
      WHERE id = ?
    `).get(episodeId)?.day_key ?? null
  }

  getProfileRecallRows(query = '', limit = 5) {
    return getProfileRecallRowsImpl(this, query, limit)
  }

  getPolicyRecallRows(query = '', limit = 5, options = {}) {
    return getPolicyRecallRowsImpl(this, query, limit, options)
  }

  getEntityRecallRows(query = '', limit = 5) {
    return getEntityRecallRowsImpl(this, query, limit)
  }

  getRelationRecallRows(query = '', limit = 5) {
    return getRelationRecallRowsImpl(this, query, limit)
  }

  async verifyMemoryClaim(query, options = {}) {
    return verifyMemoryClaimImpl(this, query, options)
  }

  getFactRecallRowById(factId) {
    return this.db.prepare(`
      SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.workstream AS workstream, f.text AS content,
             0 AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
             f.confidence AS quality_score, f.retrieval_count AS retrieval_count,
             f.source_episode_id AS source_episode_id,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
      FROM facts f
      LEFT JOIN episodes e ON e.id = f.source_episode_id
      WHERE f.id = ? AND f.status = 'active'
    `).get(factId)
  }

  async applyVerifiedFactCorrection(query, results = [], options = {}) {
    if (!query || results.length === 0) return results
    const primaryIntent = options.intent?.primary ?? 'decision'
    const topType = String(results[0]?.type ?? '')
    const shouldVerify = topType === 'task' || primaryIntent === 'decision' || primaryIntent === 'policy' || primaryIntent === 'profile'
    if (!shouldVerify) return results

    const matches = await this.verifyMemoryClaim(query, {
      limit: 2,
      queryVector: options.queryVector ?? null,
      ftsQuery: buildFtsQuery(query),
    })
    const best = matches[0]
    const correctionAccepted =
      best &&
      (
        best.accepted ||
        Boolean(best.literal_match) ||
        Number(best.lexical_overlap ?? 0) >= 0.6 ||
        (
          Number(best.lexical_overlap ?? 0) >= 0.4 &&
          Number(best.similarity ?? 0) >= 0.35
        )
      )
    if (!correctionAccepted) return results

    const existing = results.find(item => item.type === 'fact' && Number(item.entity_id) === Number(best.id))
    const factRow = existing ?? this.getFactRecallRowById(best.id)
    if (!factRow) return results

    const queryTokenCount = Math.max(1, tokenizeMemoryText(query).length)
    const overlapCount = Math.max(
      Number(factRow.overlapCount ?? 0),
      Math.round(Number(best.lexical_overlap ?? 0) * queryTokenCount),
    )
    const topScore = Number(results[0]?.weighted_score ?? 0)
    const verifiedMargin = 0.28 + Number(best.verify_score ?? 0) * 0.24
    const correctedScore = Number.isFinite(topScore)
      ? Math.min(Number(factRow.weighted_score ?? topScore), topScore - verifiedMargin)
      : Number(factRow.weighted_score ?? -verifiedMargin)
    const corrected = {
      ...factRow,
      overlapCount,
      verify_score: Number(best.verify_score ?? 0),
      lexical_overlap: Number(best.lexical_overlap ?? 0),
      literal_match: Boolean(best.literal_match),
      weighted_score: correctedScore,
      rerank_score: Math.min(Number(factRow.rerank_score ?? correctedScore), correctedScore),
    }

    if (
      topType !== 'task' &&
      topType !== 'profile' &&
      !Boolean(best.literal_match) &&
      Number(best.verify_score ?? 0) < 0.84
    ) {
      return results
    }

    const remaining = results.filter(item => !(item.type === 'fact' && Number(item.entity_id) === Number(best.id)))
    return [corrected, ...remaining].slice(0, Math.max(1, Number(options.limit ?? results.length)))
  }

  async getEpisodeRecallRows(options = {}) {
    return getEpisodeRecallRowsImpl(this, options)
  }

  async bulkVerifyHints(hints = [], options = {}) {
    return bulkVerifyHintsImpl(this, hints, options)
  }

  getRecallShortcutRows(kind = 'all', limit = 5, options = {}) {
    return getRecallShortcutRowsImpl(this, kind, limit, options)
  }

  async applyMetadataFilters(rows = [], filters = {}) {
    return applyMetadataFiltersImpl(this, rows, filters)
  }

  getEpisodesSince(timestamp) {
    return getEpisodesSinceImpl(this, timestamp)
  }

  countEpisodes() {
    return countEpisodesImpl(this)
  }

  getCandidatesForDate(dayKey) {
    return getCandidatesForDateImpl(this, dayKey)
  }

  getPendingCandidateDays(limit = 7, minCount = 1) {
    return getPendingCandidateDaysImpl(this, limit, minCount)
  }

  getDecayRows(kind = 'fact') {
    return getDecayRowsImpl(this, kind)
  }

  markRowsDeprecated(kind = 'fact', ids = [], seenAt = null) {
    return markRowsDeprecatedImpl(this, kind, ids, seenAt)
  }

  listDeprecatedIds(kind = 'fact', olderThan = '') {
    return listDeprecatedIdsImpl(this, kind, olderThan)
  }

  deleteRowsByIds(kind = 'fact', ids = []) {
    return deleteRowsByIdsImpl(this, kind, ids)
  }

  resetEmbeddingIndex(options = {}) {
    return resetEmbeddingIndexImpl(this, options)
  }

  vacuumDatabase() {
    return vacuumDatabaseImpl(this)
  }

  getRecentCandidateDays(limit = 7) {
    return getRecentCandidateDaysImpl(this, limit)
  }

  countPendingCandidates(dayKey = null) {
    return countPendingCandidatesImpl(this, dayKey)
  }

  rebuildCandidates() {
    return rebuildCandidatesImpl(this)
  }

  resetConsolidatedMemory() {
    return resetConsolidatedMemoryImpl(this)
  }

  resetConsolidatedMemoryForDays(dayKeys = []) {
    return resetConsolidatedMemoryForDaysImpl(this, dayKeys)
  }

  pruneConsolidatedMemoryOutsideDays(dayKeys = []) {
    return pruneConsolidatedMemoryOutsideDaysImpl(this, dayKeys)
  }

  markCandidateIdsConsolidated(candidateIds = []) {
    return markCandidateIdsConsolidatedImpl(this, candidateIds)
  }

  markCandidatesConsolidated(dayKey) {
    return markCandidatesConsolidatedImpl(this, dayKey)
  }

  upsertDocument(kind, docKey, content) {
    const clean = cleanMemoryText(content)
    if (!clean) return
    this.upsertDocumentStmt.run(kind, docKey, clean)
  }

  upsertProfiles(profiles = [], seenAt = null, sourceEpisodeId = null) {
    for (const profile of profiles) {
      const key = normalizeProfileKey(profile?.key)
      const value = cleanMemoryText(profile?.value)
      const confidence = Number(profile?.confidence ?? 0.6)
      if (!shouldKeepProfileValue(key, value)) continue
      this.upsertProfileStmt.run(key, value, confidence, seenAt, seenAt, sourceEpisodeId)
    }
  }

  projectTaskState(taskId) {
    const events = this.getTaskEventsStmt.all(taskId)
    if (!events.length) return null

    let stage = 'planned'
    let evidenceLevel = 'claimed'
    let status = 'active'
    let bestStageRank = taskStageRank(stage)
    let bestEvidenceRank = taskEvidenceRank(evidenceLevel)

    for (const event of events) {
      const nextStage = normalizeTaskStage(event.stage, event.note ?? '')
      const nextEvidence = normalizeEvidenceLevel(event.evidence_level, event.note ?? '')
      const nextStatus = normalizeTaskStatus(event.status, event.note ?? '')

      const stageRank = taskStageRank(nextStage)
      if (stageRank >= bestStageRank) {
        bestStageRank = stageRank
        stage = nextStage
      }

      const evidenceRank = taskEvidenceRank(nextEvidence)
      if (evidenceRank >= bestEvidenceRank) {
        bestEvidenceRank = evidenceRank
        evidenceLevel = nextEvidence
      }

      status = nextStatus
    }

    if (stage === 'done') status = 'done'
    return { stage, evidenceLevel, status }
  }

  async upsertFacts(facts = [], seenAt = null, sourceEpisodeId = null, options = {}) {
    const deprecateOnHighSimilarity = Boolean(options.deprecateOnHighSimilarity)
    for (const fact of facts) {
      const text = cleanMemoryText(fact?.text)
      const factType = normalizeFactType(fact?.type)
      const confidence = Number(fact?.confidence ?? 0.6)
      if (!text || !factType || !shouldKeepFact(factType, text, confidence)) continue
      const slot = normalizeFactSlot(fact?.slot)
      const workstream = normalizeWorkstream(fact?.workstream)
      const claimKey = deriveClaimKey(factType, slot, text, workstream)

      // Semantic dedup: check if a similar active fact already exists
      const existingExact = this.getFactIdStmt.get(factType, text)
      const existingByKey = !existingExact && claimKey ? this.getFactRowByClaimKeyStmt.get(factType, claimKey) : null
      if (existingByKey?.id) {
        this.updateFactByIdStmt.run(
          slot || null,
          claimKey || null,
          workstream || null,
          text,
          confidence,
          seenAt,
          sourceEpisodeId,
          existingByKey.id,
        )
        this.deleteFactFtsStmt.run(existingByKey.id)
        this.insertFactFtsStmt.run(existingByKey.id, text)
        this.linkMemoryToEntities(text, 'fact', existingByKey.id, sourceEpisodeId)
        this.upsertPropositions([
          {
            subjectKey: fact?.subject_key,
            propositionKind: propositionKindForFact(factType, slot),
            text,
            occurredOn: extractExplicitDate(text),
            confidence,
          },
        ], seenAt, sourceEpisodeId, existingByKey.id)
        if (slot) this.staleFactSlotStmt.run(slot, text)
        continue
      }
      if (!existingExact) {
        const newVector = await embedText(text)
        if (Array.isArray(newVector) && newVector.length > 0) {
          const activeModel = getEmbeddingModelId()
          const samTypeFacts = this.db.prepare(`
            SELECT f.id, f.text, f.confidence, mv.vector_json
            FROM facts f
            JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
            WHERE f.fact_type = ? AND f.status = 'active'
          `).all(activeModel, factType)

          let merged = false
          for (const existing of samTypeFacts) {
            try {
              const existingVector = JSON.parse(existing.vector_json)
              const similarity = cosineSimilarity(newVector, existingVector)
              if (similarity >= 0.85) {
                if (deprecateOnHighSimilarity) {
                  // Deprecate mode: mark old fact as deprecated, insert new one below
                  this.db.prepare(`UPDATE facts SET status = 'deprecated', superseded_by = NULL WHERE id = ?`).run(existing.id)
                } else {
                  // Merge: update existing fact if new one has higher confidence, bump mention
                  if (confidence > existing.confidence) {
                    this.db.prepare(`
                      UPDATE facts SET text = ?, confidence = ?, last_seen = ?, source_episode_id = COALESCE(?, source_episode_id), mention_count = mention_count + 1
                      WHERE id = ?
                    `).run(text, confidence, seenAt, sourceEpisodeId, existing.id)
                    this.deleteFactFtsStmt.run(existing.id)
                    this.insertFactFtsStmt.run(existing.id, text)
                  } else {
                    this.db.prepare(`
                      UPDATE facts SET last_seen = ?, mention_count = mention_count + 1
                      WHERE id = ?
                    `).run(seenAt, existing.id)
                  }
                  merged = true
                  break
                }
              }
            } catch { /* ignore parse errors */ }
          }
          if (merged) continue
        }
      }

      this.reviveFactsStmt.run(factType, text)
      this.upsertFactStmt.run(
        factType,
        slot || null,
        claimKey || null,
        workstream || null,
        text,
        confidence,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = (claimKey ? this.getFactIdByClaimKeyStmt.get(factType, claimKey) : null) ?? this.getFactIdStmt.get(factType, text)
      if (row?.id) {
        this.deleteFactFtsStmt.run(row.id)
        this.insertFactFtsStmt.run(row.id, text)
        this.linkMemoryToEntities(text, 'fact', row.id, sourceEpisodeId)
        this.upsertPropositions([
          {
            subjectKey: fact?.subject_key,
            propositionKind: propositionKindForFact(factType, slot),
            text,
            occurredOn: extractExplicitDate(text),
            confidence,
          },
        ], seenAt, sourceEpisodeId, row.id)
      }
      if (slot) {
        this.staleFactSlotStmt.run(slot, text)
      } else if (row?.id) {
        // Contradiction detection for slot-less facts:
        // Reuse existing vectors (no extra embedText call) to find similar facts and supersede
        try {
          const newVecRow = this.getVectorStmt.get('fact', row.id, getEmbeddingModelId())
          if (newVecRow?.vector_json) {
            const newVector = JSON.parse(newVecRow.vector_json)
            const sameFacts = this.db.prepare(`
              SELECT f.id, f.text, mv.vector_json
              FROM facts f
              JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
              WHERE f.fact_type = ? AND f.status = 'active' AND f.id != ?
            `).all(getEmbeddingModelId(), factType, row.id)
            for (const old of sameFacts) {
              try {
                const oldVector = JSON.parse(old.vector_json)
                const sim = cosineSimilarity(newVector, oldVector)
                if (sim > 0.75 && old.text !== text) {
                  this.db.prepare(`UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(row.id, old.id)
                }
              } catch {}
            }
          }
        } catch {}
      }
      const profileKey = profileKeyForFact(factType, text, slot)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, text, confidence, seenAt, seenAt, sourceEpisodeId)
      }
    }
    for (const kind of ['decision', 'preference', 'constraint', 'fact']) {
      this.markFactsStaleStmt.run(kind, staleCutoffDays(kind))
    }
  }

  upsertTasks(tasks = [], seenAt = null, sourceEpisodeId = null) {
    for (const task of tasks) {
      const title = cleanMemoryText(task?.title)
      if (!title) continue
      const details = composeTaskDetails({
        ...task,
        scope: task?.scope ?? inferTaskScope(task),
        activity: task?.activity ?? inferTaskActivity(task),
      })
      const workstream = normalizeWorkstream(task?.workstream)
      const taskKey = deriveTaskKey(title, workstream)
      const stage = normalizeTaskStage(task?.stage, details)
      const evidenceLevel = normalizeEvidenceLevel(task?.evidence_level, details)
      const prev = this.getTaskRowByKeyStmt.get(taskKey) ?? this.getTaskRowStmt.get(title)
      if (prev?.id && prev.title && prev.title !== title) {
        this.updateTaskByIdStmt.run(
          title,
          taskKey,
          details || null,
          workstream || null,
          stage,
          evidenceLevel,
          normalizeTaskStatus(task?.status, details),
          normalizeTaskPriority(task?.priority),
          Number(task?.confidence ?? 0.6),
          seenAt,
          sourceEpisodeId,
          prev.id,
        )
        this.deleteTaskFtsStmt.run(prev.id)
        this.insertTaskFtsStmt.run(prev.id, title, details)
        this.linkMemoryToEntities(`${title} ${details ?? ''}`, 'task', prev.id, sourceEpisodeId)
        this.insertTaskEventStmt.run(
          prev.id,
          seenAt,
          'projection_update',
          stage,
          evidenceLevel,
          normalizeTaskStatus(task?.status, details),
          details || null,
          sourceEpisodeId,
        )
        continue
      }
      this.upsertTaskStmt.run(
        title,
        taskKey,
        details || null,
        workstream || null,
        stage,
        evidenceLevel,
        normalizeTaskStatus(task?.status, details),
        normalizeTaskPriority(task?.priority),
        Number(task?.confidence ?? 0.6),
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getTaskIdByKeyStmt.get(taskKey) ?? this.getTaskIdStmt.get(title)
      if (row?.id) {
        this.deleteTaskFtsStmt.run(row.id)
        this.insertTaskFtsStmt.run(row.id, title, details)
        this.linkMemoryToEntities(`${title} ${details ?? ''}`, 'task', row.id, sourceEpisodeId)
        const changed =
          !prev ||
          prev.status !== normalizeTaskStatus(task?.status, details) ||
          prev.stage !== stage ||
          prev.evidence_level !== evidenceLevel
        if (changed) {
          this.insertTaskEventStmt.run(
            row.id,
            seenAt ?? new Date().toISOString(),
            prev ? 'state_update' : 'task_created',
            stage,
            evidenceLevel,
            normalizeTaskStatus(task?.status, details),
            details || null,
            sourceEpisodeId,
          )
          const projected = this.projectTaskState(row.id)
          if (projected) {
            this.updateTaskProjectionStmt.run(projected.stage, projected.evidenceLevel, projected.status, row.id)
          }
        }
      }
    }
    this.markTasksStaleStmt.run()
  }

  replaceInterests(interests = []) {
    this.clearInterestsStmt.run()
    for (const item of interests) {
      if (!item?.name) continue
      this.insertInterestStmt.run(
        String(item.name).trim(),
        Number(item.score ?? item.count ?? 1),
        Number(item.count ?? Math.max(1, Math.round(Number(item.score ?? 1) * 10))),
        item.last_seen ?? item.last ?? null,
      )
    }
  }

  upsertSignals(signals = [], sourceEpisodeId = null, seenAt = null) {
    const seenKeys = new Set()
    for (const signal of signals) {
      if (!signal?.kind || !signal?.value) continue
      const kind = normalizeSignalKind(signal.kind)
      const value = String(signal.value).trim()
      const normalizedValue = cleanMemoryText(value)
      const score = Number(signal.score ?? 0.5)
      if (!shouldKeepSignal(kind, normalizedValue, score)) continue
      if (!normalizedValue) continue
      const dedupeKey = `${kind}:${normalizedValue.toLowerCase()}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      this.upsertSignalStmt.run(
        kind,
        normalizedValue,
        score,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getSignalIdStmt.get(kind, normalizedValue)
      if (row?.id) {
        this.deleteSignalFtsStmt.run(row.id)
        this.insertSignalFtsStmt.run(row.id, kind, normalizedValue)
      }
      const profileKey = profileKeyForSignal(kind, normalizedValue)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, normalizedValue, score, seenAt, seenAt, sourceEpisodeId)
      }
    }
  }

  upsertEntities(entities = [], seenAt = null, sourceEpisodeId = null) {
    for (const entity of entities) {
      const name = cleanMemoryText(entity?.name)
      const entityType = String(entity?.type ?? 'thing').toLowerCase().trim()
      const description = cleanMemoryText(entity?.description ?? '')
      if (!name || name.length < 2) continue
      try {
        this.db.prepare(`
          INSERT INTO entities (name, entity_type, description, first_seen, last_seen, source_episode_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(name, entity_type) DO UPDATE SET
            description = COALESCE(excluded.description, entities.description),
            last_seen = excluded.last_seen,
            source_episode_id = COALESCE(excluded.source_episode_id, entities.source_episode_id)
        `).run(name, entityType, description || null, seenAt, seenAt, sourceEpisodeId)
      } catch {}
    }
  }

  upsertRelations(relations = [], seenAt = null, sourceEpisodeId = null) {
    for (const rel of relations) {
      const sourceName = cleanMemoryText(rel?.source)
      const targetName = cleanMemoryText(rel?.target)
      const relType = String(rel?.type ?? 'related_to').toLowerCase().trim()
      const description = cleanMemoryText(rel?.description ?? '')
      const confidence = Number(rel?.confidence ?? 0.7)
      if (!sourceName || !targetName || sourceName.length < 2 || targetName.length < 2) continue
      try {
        const sourceEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(sourceName)
        const targetEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(targetName)
        if (!sourceEntity || !targetEntity) continue
        this.db.prepare(`
          INSERT INTO relations (source_entity_id, target_entity_id, relation_type, description, confidence, first_seen, last_seen, source_episode_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
            description = COALESCE(excluded.description, relations.description),
            confidence = MAX(relations.confidence, excluded.confidence),
            last_seen = excluded.last_seen,
            source_episode_id = COALESCE(excluded.source_episode_id, relations.source_episode_id)
        `).run(sourceEntity.id, targetEntity.id, relType, description || null, confidence, seenAt, seenAt, sourceEpisodeId)
      } catch {}
    }
  }

  getEntityGraph(entityName) {
    const entity = this.db.prepare('SELECT * FROM entities WHERE name = ?').get(entityName)
    if (!entity) return null
    const outgoing = this.db.prepare(`
      SELECT r.relation_type, e.name AS target, e.entity_type AS target_type, r.description, r.confidence
      FROM relations r JOIN entities e ON e.id = r.target_entity_id
      WHERE r.source_entity_id = ? AND r.status = 'active'
    `).all(entity.id)
    const incoming = this.db.prepare(`
      SELECT r.relation_type, e.name AS source, e.entity_type AS source_type, r.description, r.confidence
      FROM relations r JOIN entities e ON e.id = r.source_entity_id
      WHERE r.target_entity_id = ? AND r.status = 'active'
    `).all(entity.id)
    return { entity, outgoing, incoming }
  }

  syncHistoryFromFiles() {
    ensureDir(this.historyDir)

    for (const docKey of ['identity', 'ongoing', 'context']) {
      const filePath = join(this.historyDir, `${docKey}.md`)
      if (!existsSync(filePath)) continue
      this.upsertDocument(docKey, docKey, readFileSync(filePath, 'utf8'))
    }

    const interestsPath = join(this.historyDir, 'interests.json')
    if (existsSync(interestsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(interestsPath, 'utf8'))
        const items = Object.entries(parsed).map(([name, value]) => ({
          name,
          score: typeof value?.count === 'number' ? value.count : 1,
          count: typeof value?.count === 'number' ? value.count : 1,
          last_seen: value?.last ?? null,
        }))
        this.replaceInterests(items)
      } catch { /* ignore malformed interests */ }
    }
  }

  backfillProject(workspacePath, options = {}) {
    const limit = Number(options.limit ?? 50)
    const projectDir = join(homedir(), '.claude', 'projects', workspaceToProjectSlug(workspacePath))
    if (!existsSync(projectDir)) return 0
    const files = readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        path: join(projectDir, file),
        mtime: statSync(join(projectDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(item => item.path)
      .reverse()
    return this.ingestTranscriptFiles(files)
  }

  buildContextText() {
    const parts = []

    // ## Bot — bot.md + tone/style signals
    const botMdPath = join(this.dataDir, 'bot.md')
    let botContent = ''
    try { botContent = readFileSync(botMdPath, 'utf8').trim() } catch {}
    const toneSignals = this.db.prepare(`
      SELECT kind, value, score FROM signals
      WHERE kind IN ('tone', 'response_style', 'personality') AND status = 'active'
      ORDER BY score DESC LIMIT 3
    `).all()
    if (botContent || toneSignals.length) {
      parts.push('## Bot')
      if (botContent) parts.push(botContent)
      if (toneSignals.length) {
        const seen = new Set()
        const dedupedSignals = toneSignals.filter(s => {
          if (seen.has(s.kind)) return false
          seen.add(s.kind)
          return true
        })
        parts.push(dedupedSignals.map(s => `- ${s.kind}: ${s.value}`).join('\n'))
      }
    }

    // ## User — profiles DB
    const profiles = this.db.prepare(`
      SELECT key, value, confidence FROM profiles
      WHERE status = 'active'
      ORDER BY confidence DESC LIMIT 10
    `).all().filter(profile => shouldKeepProfileValue(profile.key, profile.value))
    if (profiles.length) {
      parts.push(`## User\n${profiles.map(p => `- ${p.key}: ${p.value}`).join('\n')}`)
    }

    // ## Core Memory — preference/constraint facts
    const coreFacts = this.db.prepare(`
      SELECT fact_type, text
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (coreFacts.length > 0) {
      parts.push(`## Core Memory\n${coreFacts.map(item => `- [${item.fact_type}] ${item.text}`).join('\n')}`)
    }

    // ## Decisions — decision/fact facts
    const durableFacts = this.db.prepare(`
      SELECT fact_type, text
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('decision', 'fact')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (durableFacts.length > 0) {
      const grouped = new Map()
      for (const row of durableFacts) {
        const bucket = grouped.get(row.fact_type) ?? []
        bucket.push(row)
        grouped.set(row.fact_type, bucket)
      }
      const lines = []
      for (const [factType, values] of grouped.entries()) {
        const label = factType[0].toUpperCase() + factType.slice(1)
        lines.push(`### ${label}\n${values.map(value => `- ${value.text}`).join('\n')}`)
      }
      parts.push(`## Decisions\n${lines.join('\n\n')}`)
    }

    // ## Ongoing — active tasks
    const tasks = this.db.prepare(`
      SELECT title, details, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        retrieval_count DESC,
        last_seen DESC
      LIMIT 8
    `).all()
    if (tasks.length > 0) {
      const lines = tasks.map(task => {
        const detail = task.details ? ` — ${task.details}` : ''
        return `- [${task.status}/${task.stage}/${task.evidence_level}] ${task.title}${detail}`
      })
      parts.push(`## Ongoing\n${lines.join('\n')}`)
    } else {
      const ongoing = this.db.prepare(`
        SELECT content FROM documents WHERE kind = 'ongoing' AND doc_key = 'ongoing'
      `).get()
      if (ongoing?.content) parts.push(`## Ongoing\n${ongoing.content}`)
    }

    // ## Dev Worklog — active dev tasks with entity context
    const devTasks = this.db.prepare(`
      SELECT t.id, t.title, t.details, t.workstream, t.stage, t.status, t.last_seen
      FROM tasks t
      WHERE t.status IN ('active', 'in_progress', 'paused')
      ORDER BY
        CASE t.status WHEN 'in_progress' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
        t.last_seen DESC
      LIMIT 8
    `).all().filter(task => {
      const parsed = parseTaskDetails(task.details)
      return isDevelopmentFacet({
        ...task,
        scope: parsed.scope,
        activity: parsed.activity,
      })
    })
    if (devTasks.length > 0) {
      const lines = devTasks.map(task => {
        const { currentState, nextStep, description, scope, activity } = parseTaskDetails(task.details)
        const entities = this.db.prepare(`
          SELECT e.name, e.entity_type
          FROM entities e
          JOIN entity_links el ON el.entity_id = e.id
          WHERE el.linked_type = 'task' AND el.linked_id = ?
          ORDER BY e.entity_type, e.last_seen DESC
        `).all(task.id)
        const files = entities.filter(e => e.entity_type === 'file').map(e => e.name)
        const bugs = entities.filter(e => e.entity_type === 'bug').map(e => e.name)
        const workstream = String(task.workstream ?? '').trim() || 'dev/unknown'
        const label = workstream.startsWith('dev-') ? workstream.replace(/-/g, '/') : workstream
        const facet = [scope, activity].filter(Boolean).join('/')
        const partsForTask = [`- ${task.title} [${facet ? `${facet} | ` : ''}${label}]`]
        if (files.length > 0) partsForTask.push(`  - touched: ${files.join(', ')}`)
        if (bugs.length > 0) partsForTask.push(`  - bugs: ${bugs.join(', ')}`)
        if (currentState) partsForTask.push(`  - state: ${currentState}`)
        if (nextStep) partsForTask.push(`  - next: ${nextStep}`)
        if (!currentState && description) partsForTask.push(`  - note: ${description}`)
        return partsForTask.join('\n')
      })
      parts.push(`## Dev Worklog\n${lines.join('\n\n')}`)
    }

    // ## Signals — top signals with decay
    const signals = this.db.prepare(`
      SELECT kind, value, score, last_seen, retrieval_count
      FROM signals
      WHERE status = 'active'
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 8
    `).all()
    const activeSignals = signals
      .filter(s => !['tone', 'response_style', 'personality'].includes(s.kind))
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
      }))
      .filter(item => item.effectiveScore >= 0.35)
      .filter((item, index, arr) => arr.findIndex(candidate => candidate.kind === item.kind) === index)
      .slice(0, 5)
    if (activeSignals.length > 0) {
      parts.push(`## Signals\n${activeSignals.map(item => `- [${item.kind}] ${item.value}`).join('\n')}`)
    }

    // ## Recent — direct recent episode slices first, stored summaries only as fallback/supplement
    const recentSections = []
    const recentSectionKeys = new Set()
    const recentRows = this.db.prepare(`
      SELECT day_key, ts, role, content
      FROM episodes
      WHERE kind = 'message'
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'You are analyzing%'
      ORDER BY day_key DESC, ts ASC, id ASC
      LIMIT 40
    `).all()
    const grouped = new Map()
    for (const row of recentRows) {
      const dayKey = String(row.day_key ?? '').trim()
      if (!dayKey) continue
      if (!grouped.has(dayKey) && grouped.size >= 2) continue
      const bucket = grouped.get(dayKey) ?? []
      bucket.push(row)
      grouped.set(dayKey, bucket)
    }
    for (const [dayKey, rows] of Array.from(grouped.entries())) {
      const lines = rows
        .slice(-4)
        .map(row => `- ${row.role === 'user' ? 'u' : 'a'}: ${cleanMemoryText(row.content).slice(0, 180)}`)
      if (lines.length === 0) continue
      recentSections.push(`### ${dayKey}\n${lines.join('\n')}`)
      recentSectionKeys.add(dayKey)
    }
    if (recentSections.length < 2) {
      const dailyDocs = this.db.prepare(`
        SELECT doc_key, content
        FROM documents
        WHERE kind = 'daily'
        ORDER BY doc_key DESC
        LIMIT 2
      `).all()
      for (const row of dailyDocs) {
        const docKey = String(row.doc_key ?? '').trim()
        const content = String(row.content ?? '').trim()
        if (!docKey || !content || recentSectionKeys.has(docKey)) continue
        recentSections.push(`### ${docKey}\n${content}`)
        recentSectionKeys.add(docKey)
        if (recentSections.length >= 2) break
      }
    }
    if (recentSections.length < 2) {
      const dailyDir = join(this.historyDir, 'daily')
      if (existsSync(dailyDir)) {
        const files = readdirSync(dailyDir)
          .filter(name => name.endsWith('.md'))
          .sort()
          .slice(-2)
          .reverse()
        for (const name of files) {
          const docKey = name.replace(/\.md$/, '')
          if (recentSectionKeys.has(docKey)) continue
          try {
            const content = readFileSync(join(dailyDir, name), 'utf8').trim()
            if (!content) continue
            recentSections.push(`### ${docKey}\n${content}`)
            recentSectionKeys.add(docKey)
            if (recentSections.length >= 2) break
          } catch { /* ignore unreadable summary */ }
        }
      }
    }
    if (recentSections.length > 0) {
      parts.push(`## Recent\n${recentSections.join('\n\n')}`)
    }

    // Fallback — all sections empty → recent dialogues
    if (parts.length === 0) {
      const recentEpisodes = this.db.prepare(`
        SELECT DISTINCT role, content
        FROM episodes
        WHERE kind = 'message'
        ORDER BY ts DESC, id DESC
        LIMIT 12
      `).all().reverse()
      if (recentEpisodes.length > 0) {
        const body = recentEpisodes
          .map(row => `${row.role === 'user' ? 'u' : 'a'}: ${row.content}`)
          .join('\n')
        parts.push(`## Recent Dialogues\n${body}`)
      }
    }

    return parts.join('\n\n').trim()
  }

  writeContextFile() {
    const contextPath = join(this.historyDir, 'context.md')
    ensureDir(this.historyDir)
    const content = this.buildContextText()
    writeFileSync(contextPath, `<!-- Auto-generated by memory store -->\n\n${content}\n`)
    return contextPath
  }

  appendRetrievalTrace(record = {}) {
    try {
      ensureDir(this.historyDir)
      const tracePath = join(this.historyDir, 'retrieval-trace.jsonl')
      appendFileSync(tracePath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      logIgnoredError('appendRetrievalTrace', error)
    }
  }

  async warmupEmbeddings() {
    await warmupEmbeddingProvider()
  }

  getEmbeddableItems(options = {}) {
    const perTypeLimit = options.all
      ? 1000000000
      : Math.max(1, Number(options.perTypeLimit ?? 64))
    const items = []

    const factRows = this.db.prepare(`
      SELECT id, fact_type AS subtype, slot, workstream, text AS content
      FROM facts
      WHERE status = 'active'
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of factRows) {
      items.push({
        key: embeddingItemKey('fact', row.id),
        entityType: 'fact',
        entityId: row.id,
        subtype: row.subtype,
        slot: row.slot,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const taskRows = this.db.prepare(`
      SELECT id, status, priority, stage, evidence_level, workstream,
             trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of taskRows) {
      items.push({
        key: embeddingItemKey('task', row.id),
        entityType: 'task',
        entityId: row.id,
        status: row.status,
        priority: row.priority,
        stage: row.stage,
        evidenceLevel: row.evidence_level,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const signalRows = this.db.prepare(`
      SELECT id, kind AS subtype, value AS content
      FROM signals
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit * 0.75)))
    for (const row of signalRows) {
      items.push({
        key: embeddingItemKey('signal', row.id),
        entityType: 'signal',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    const propositionRows = this.db.prepare(`
      SELECT id, proposition_kind AS subtype, text AS content
      FROM propositions
      WHERE status = 'active'
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit * 0.75)))
    for (const row of propositionRows) {
      items.push({
        key: embeddingItemKey('proposition', row.id),
        entityType: 'proposition',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    const episodeLimit = Math.max(8, Math.floor(perTypeLimit / 2))
    const episodeRows = this.db.prepare(`
      SELECT id, role AS subtype, day_key AS ref, content
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
        AND LENGTH(content) BETWEEN 10 AND 1500
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'Answer using live%'
        AND content NOT LIKE 'Use the ai_search%'
        AND content NOT LIKE 'Say only%'
        AND ts >= datetime('now', '-30 days')
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(episodeLimit)
    for (const row of episodeRows) {
      items.push({
        key: embeddingItemKey('episode', row.id),
        entityType: 'episode',
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: row.content,
      })
    }

    // Entity embeddings
    const entityRows = this.db.prepare(`
      SELECT id, entity_type AS subtype,
             trim(name || CASE WHEN description IS NOT NULL AND description != '' THEN ' — ' || description ELSE '' END) AS content
      FROM entities
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit / 2)))
    for (const row of entityRows) {
      items.push({
        key: embeddingItemKey('entity', row.id),
        entityType: 'entity',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    // Relation embeddings
    const relationRows = this.db.prepare(`
      SELECT r.id, r.relation_type AS subtype,
             trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.status = 'active'
      ORDER BY r.confidence DESC, r.last_seen DESC, r.id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit / 2)))
    for (const row of relationRows) {
      items.push({
        key: embeddingItemKey('relation', row.id),
        entityType: 'relation',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    return items
  }

  async ensureEmbeddings(options = {}) {
    const candidates = this.getEmbeddableItems(options)
    const contextMap = options.contextMap instanceof Map ? options.contextMap : new Map()

    // Check config: when embedding.contextualize === false, use raw content without metadata prefixes
    let contextualizeLocal = true
    try {
      const cfg = JSON.parse(readFileSync(join(this.dataDir, 'config.json'), 'utf8'))
      if (cfg?.embedding?.contextualize === false) contextualizeLocal = false
    } catch {}

    let updated = 0
    for (const item of candidates) {
      const lookupModel = getEmbeddingModelId()
      const contextText = contextMap.get(item.key)
      let embedInput
      if (contextText) {
        embedInput = cleanMemoryText(`${contextText}\n${item.content}`)
      } else if (contextualizeLocal) {
        embedInput = contextualizeEmbeddingInput(item)
      } else {
        embedInput = cleanMemoryText(item.content ?? '')
      }
      if (!embedInput) continue
      const contentHash = hashEmbeddingInput(embedInput)
      const existing = this.getVectorStmt.get(item.entityType, item.entityId, lookupModel)
      if (existing?.content_hash === contentHash) continue
      const vector = await embedText(embedInput)
      if (!Array.isArray(vector) || vector.length === 0) continue
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        activeModel,
        vector.length,
        JSON.stringify(vector),
        contentHash,
      )
      this._syncToVecTable(item.entityType, item.entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
      updated += 1
    }
    this._pruneOldEpisodeVectors()
    return updated
  }

  _syncToVecTable(entityType, entityId, vector) {
    if (!this.vecEnabled) return
    const rowid = this._vecRowId(entityType, entityId)
    try {
      const hex = vecToHex(vector)
      this.db.exec(`INSERT OR REPLACE INTO vec_memory(rowid, embedding) VALUES (${rowid}, X'${hex}')`)
    } catch { /* ignore */ }
  }

  _vecRowId(entityType, entityId) {
    // Pack entity type + id into a single integer rowid
    const typePrefix = { fact: 1, task: 2, signal: 3, episode: 4, proposition: 5, entity: 6, relation: 7 }
    return (typePrefix[entityType] ?? 9) * 10000000 + Number(entityId)
  }

  _vecRowToEntity(rowid) {
    const typeMap = { 1: 'fact', 2: 'task', 3: 'signal', 4: 'episode', 5: 'proposition', 6: 'entity', 7: 'relation' }
    const typeNum = Math.floor(rowid / 10000000)
    return { entityType: typeMap[typeNum] ?? 'unknown', entityId: rowid % 10000000 }
  }

  _pruneOldEpisodeVectors() {
    // TTL: remove episode vectors older than 30 days
    try {
      const cutoff = this.db.prepare(`
        SELECT id FROM episodes
        WHERE ts < datetime('now', '-30 days')
          AND id IN (SELECT entity_id FROM memory_vectors WHERE entity_type = 'episode')
      `).all()
      for (const { id } of cutoff) {
        this.db.prepare('DELETE FROM memory_vectors WHERE entity_type = ? AND entity_id = ?').run('episode', id)
        if (this.vecEnabled) {
          const rowid = this._vecRowId('episode', id)
          try { this.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
      if (cutoff.length > 0) {
        process.stderr.write(`[memory] pruned ${cutoff.length} old episode vectors\n`)
      }
    } catch { /* ignore */ }
  }

  async classifyQueryIntent(query, queryVector = null, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) {
      return {
        primary: 'decision',
        scores: { profile: 0, task: 0, decision: 0, policy: 0, security: 0, event: 0, history: 0 },
      }
    }

    const tuning = options.tuning ?? this.getRetrievalTuning()
    const vector = queryVector ?? await embedText(clean)
    const prototypeVectors = await getIntentPrototypeVectors()
    const scores = {
      profile: 0,
      task: 0,
      decision: 0,
      policy: 0,
      security: 0,
      event: 0,
      history: 0,
    }

    for (const [intent, vectors] of prototypeVectors.entries()) {
      let best = 0
      for (const candidate of vectors) {
        best = Math.max(best, cosineSimilarity(vector, candidate))
      }
      scores[intent] = best
    }

    applyLexicalIntentHints(clean, scores)
    const devBias = detectDevQueryBias(clean)
    const devBiasConfig = tuning?.devBias ?? DEFAULT_MEMORY_TUNING.devBias
    if (devBias > 0) {
      scores.task += devBias * Number(devBiasConfig.taskBoost ?? 0.25)
      scores.decision += devBias * Number(devBiasConfig.decisionBoost ?? 0.15)
      scores.profile = Math.max(0, scores.profile - devBias * Number(devBiasConfig.profileSuppress ?? 0.15))
      scores.event = Math.max(0, scores.event - devBias * Number(devBiasConfig.eventSuppress ?? 0.08))
    }
    const profileSlot = detectProfileQuerySlot(clean)
    const scopedEntities = this.resolveQueryEntityScope(clean)
    if (scopedEntities.length >= 2) {
      scores.decision = Number((scores.decision + 0.34).toFixed(4))
      scores.profile = Math.max(0, scores.profile - 0.12)
      scores.security = Math.max(0, scores.security - 0.1)
      scores.task = Math.max(0, scores.task - 0.08)
    } else if (scopedEntities.length === 1 && isRelationQuery(clean)) {
      scores.decision = Number((scores.decision + 0.18).toFixed(4))
      scores.profile = Math.max(0, scores.profile - 0.08)
      scores.security = Math.max(0, scores.security - 0.08)
    }

    const temporal = parseTemporalHint(clean)
    if (temporal) {
      const historyRecallCue = /뭐했|뭐라고|했지|했어|어떻게|무슨|작업|진행|discuss|did|what.*do|how|work/i.test(clean)
      const eventCue = /사건|이벤트|incident|event|meeting|회의/i.test(clean)
      if (historyRecallCue && !eventCue) {
        scores.history += 0.28
        scores.event += 0.10
      } else if (eventCue && !historyRecallCue) {
        scores.event += 0.28
        scores.history += 0.10
      } else {
        scores.event += 0.20
        scores.history += 0.20
      }
    }

    if (profileSlot) {
      scores.history = Math.max(0, scores.history - 0.2)
      scores.event = Math.max(0, scores.event - 0.16)
    }

    const timezonePreferenceCue =
      profileSlot === 'timezone' &&
      !temporal &&
      (
        /\b(local|device|timezone|timestamp|locale)\b/.test(clean.toLowerCase()) ||
        /로컬|디바이스|시간대|타임존/.test(clean)
      )
    if (timezonePreferenceCue) {
      return { primary: 'profile', scores }
    }

    const rankedIntents = Object.entries(scores).sort((a, b) => b[1] - a[1])
    let primary = rankedIntents[0]?.[0] ?? 'decision'
    const topScore = Number(rankedIntents[0]?.[1] ?? 0)
    const secondScore = Number(rankedIntents[1]?.[1] ?? 0)
    const topScoreMin = Number(tuning?.intent?.topScoreMin ?? DEFAULT_MEMORY_TUNING.intent.topScoreMin)
    const gapMin = Number(tuning?.intent?.gapMin ?? DEFAULT_MEMORY_TUNING.intent.gapMin)
    const weakPrediction = topScore < topScoreMin || (topScore - secondScore) < gapMin
    const hasStrongCue =
      Boolean(profileSlot) ||
      Boolean(temporal) ||
      isDoneTaskQuery(clean) ||
      isRuleQuery(clean) ||
      isRelationQuery(clean) ||
      /\b(task|tasks|work|working|todo|next step|in progress|current work)\b/.test(clean.toLowerCase()) ||
      /작업|진행|진행중|할 일|할일|다음/.test(clean)
    if (weakPrediction && !hasStrongCue) {
      primary = 'decision'
    }

    return { primary, scores, topScore, secondScore, weakPrediction, devBias }
  }

  async buildRecentFocusVector(options = {}) {
    const maxEpisodes = Math.max(1, Number(options.maxEpisodes ?? 8))
    const sinceDays = Math.max(1, Number(options.sinceDays ?? 3))
    const channelId = String(options.channelId ?? '').trim()
    const userId = String(options.userId ?? '').trim()
    let rows = []

    if (channelId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND channel_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(channelId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0 && userId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND user_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(userId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(`-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) return []
    const vectors = await Promise.all(
      rows.map(row => this.getStoredVector('episode', row.id, cleanMemoryText(row.content))),
    )
    return averageVectors(vectors)
  }

  async rankIntentSeedItems(rows, query = '', queryVector = null, options = {}) {
    if (!rows.length) return []
    const vector = query ? (queryVector ?? await embedText(query)) : null
    const tokens = new Set(tokenizeMemoryText(query))
    const minSimilarity = Number(options.minSimilarity ?? 0)

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(row.content ?? '')
      const contentTokens = tokenizeMemoryText(`${row.subtype ?? ''} ${content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0)
      const entityType = row.type ?? 'fact'
      const entityId = Number(row.entity_id ?? 0)
      const rowVector = (vector && entityId > 0)
        ? await this.getStoredVector(entityType, entityId, `${row.subtype ?? ''} ${content}`)
        : (vector ? await embedText(String(`${row.subtype ?? ''} ${content}`).slice(0, 320)) : [])
      const semanticSimilarity = vector
        ? cosineSimilarity(vector, rowVector)
        : 0
      return {
        ...row,
        semanticSimilarity,
        overlapCount,
        seedRank: semanticSimilarity * 4 + overlapCount * 2 + Number(row.quality_score ?? 0.5),
      }
    }))

    return scored
      .filter(item => item.overlapCount > 0 || item.semanticSimilarity >= minSimilarity || minSimilarity <= 0)
      .sort((a, b) => Number(b.seedRank) - Number(a.seedRank))
  }

  async getSeedResultsForIntent(intent, query = '', queryVector = null, limit = 4, options = {}) {
    const plan = buildMemoryQueryPlan(query, { primary: intent }, {
      limit,
      queryEntities: Array.isArray(options.queryEntities) ? options.queryEntities : [],
      includeDoneTasks: isDoneTaskQuery(query),
    })
    return getSeedResultsForPlan(this, plan, queryVector)
  }

  searchRelevant(query, limit = 8) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const results = this.combineRetrievalResults(clean, this.searchRelevantSparse(clean, limit * 2), [], limit)
    this.recordRetrieval(results)
    return results
  }

  async searchRelevantHybrid(query, limit = 8, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const shouldRecordRetrieval = options.recordRetrieval !== false
    const tuning = options.tuning ?? this.getRetrievalTuning()
    const queryVector = options.queryVector ?? await embedText(clean)
    const intent = options.intent ?? await this.classifyQueryIntent(clean, queryVector, { tuning })
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const plan = buildMemoryQueryPlan(clean, intent, {
      limit,
      queryEntities: options.queryEntities ?? this.resolveQueryEntityScope(clean),
      filters: options.filters,
    })
    const { sparse, dense } = await buildHybridRetrievalInputs(this, plan, queryVector, focusVector)
    const combined = this.combineRetrievalResults(clean, sparse, dense, limit, intent, plan.queryEntities, {
      graphFirst: plan.graphFirst,
      tuning,
      preferActiveTasks: plan.preferActiveTasks,
    })
    const exactResults = applyExactHistorySelection(plan, combined, limit, { tuning })
    const finalResults = await this.applyVerifiedFactCorrection(clean, exactResults, {
      limit,
      intent,
      queryVector,
    })
    if (shouldRecordRetrieval) this.recordRetrieval(finalResults)
    const debugSummary = summarizeRetrieverDebug(plan, sparse, dense, finalResults)
    const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (options.trace || options.debug) {
      this.appendRetrievalTrace({
        trace_id: traceId,
        ts: new Date().toISOString(),
        query: clean,
        debug: debugSummary,
      })
    }
    if (options.debug) {
      return {
        results: finalResults,
        debug: {
          trace_id: traceId,
          ...debugSummary,
        },
      }
    }
    return finalResults
  }

  searchRelevantSparse(query, limit = 8) {
    const ftsQuery = buildFtsQuery(query)
    const shortTokens = getShortTokensForLike(query)
    const includeDoneTasks = isDoneTaskQuery(query)
    if (!ftsQuery && shortTokens.length === 0) return []
    const results = []
    const runFts = Boolean(ftsQuery)

    if (runFts) {
      try {
      const factHits = this.db.prepare(`
        SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.workstream AS workstream, f.text AS content,
               bm25(facts_fts) AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
               f.confidence AS quality_score,
               f.retrieval_count AS retrieval_count,
               f.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        LEFT JOIN episodes e ON e.id = f.source_episode_id
        WHERE facts_fts MATCH ?
          AND f.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...factHits)
      } catch (error) { logIgnoredError('searchRelevantSparse facts fts', error) }
    }

    if (runFts) {
      try {
      const taskHits = this.db.prepare(`
        SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref, t.workstream AS workstream,
               trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
               bm25(tasks_fts) AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
               t.confidence AS quality_score,
               t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
               t.retrieval_count AS retrieval_count,
               t.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM tasks_fts
        JOIN tasks t ON t.id = tasks_fts.rowid
        LEFT JOIN episodes e ON e.id = t.source_episode_id
        WHERE tasks_fts MATCH ?
          AND t.status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...taskHits)
      } catch (error) { logIgnoredError('searchRelevantSparse tasks fts', error) }
    }

    if (runFts) {
      try {
      const signalHits = this.db.prepare(`
        SELECT 'signal' AS type, s.kind AS subtype, CAST(s.id AS TEXT) AS ref,
               s.value AS content, bm25(signals_fts) AS score,
               unixepoch(s.last_seen) AS updated_at, s.id AS entity_id, s.retrieval_count AS retrieval_count,
               s.score AS quality_score,
               s.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM signals_fts
        JOIN signals s ON s.id = signals_fts.rowid
        LEFT JOIN episodes e ON e.id = s.source_episode_id
        WHERE signals_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...signalHits)
      } catch (error) { logIgnoredError('searchRelevantSparse signals fts', error) }
    }

    if (runFts) {
      try {
      const propositionHits = this.db.prepare(`
        SELECT 'proposition' AS type, p.proposition_kind AS subtype, CAST(p.id AS TEXT) AS ref,
               p.text AS content, bm25(propositions_fts) AS score,
               unixepoch(p.last_seen) AS updated_at, p.id AS entity_id, p.retrieval_count AS retrieval_count,
               p.confidence AS quality_score,
               p.source_episode_id AS source_episode_id,
               p.source_fact_id AS source_fact_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM propositions_fts
        JOIN propositions p ON p.id = propositions_fts.rowid
        LEFT JOIN episodes e ON e.id = p.source_episode_id
        WHERE propositions_fts MATCH ?
          AND p.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...propositionHits)
      } catch (error) { logIgnoredError('searchRelevantSparse propositions fts', error) }
    }

    if (runFts) {
      try {
      const episodeHits = this.db.prepare(`
        SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
               e.content AS content, bm25(episodes_fts) AS score,
               e.created_at AS updated_at, e.id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ?
          AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
          AND e.content NOT LIKE 'You are consolidating%'
          AND e.content NOT LIKE 'You are improving%'
          AND e.content NOT LIKE 'You are analyzing%'
          AND e.content NOT LIKE 'Answer using live%'
          AND e.content NOT LIKE 'Use the ai_search%'
          AND e.content NOT LIKE 'Say only%'
          AND e.content NOT LIKE 'Compress these summaries%'
          AND e.content NOT LIKE 'Summarize the conversation%'
          AND LENGTH(e.content) >= 10
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, Math.min(limit, 6))
        results.push(...episodeHits)
      } catch (error) { logIgnoredError('searchRelevantSparse episodes fts', error) }
    }

    // LIKE fallback for 2-char Korean tokens that trigram can't index
    if (shortTokens.length > 0 && results.length < limit) {
      const seen = new Set(results.map(r => `${r.type}:${r.entity_id}`))
      const likeConditions = shortTokens.map(() => 'f.text LIKE ?').join(' OR ')
      const likeParams = shortTokens.map(t => `%${t}%`)
      try {
        const likeFacts = this.db.prepare(`
          SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.text AS content,
                 0 AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
                 f.confidence AS quality_score, f.retrieval_count AS retrieval_count,
                 f.source_episode_id AS source_episode_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM facts f
          LEFT JOIN episodes e ON e.id = f.source_episode_id
          WHERE f.status = 'active' AND (${likeConditions})
          LIMIT ?
        `).all(...likeParams, Math.min(limit, 4))
        for (const hit of likeFacts) {
          if (seen.has(`fact:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(`fact:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse facts like', error) }
      try {
        const likeTasks = this.db.prepare(`
          SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref,
                 trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
                 0 AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
                 t.confidence AS quality_score, t.retrieval_count AS retrieval_count,
                 t.source_episode_id AS source_episode_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM tasks t
          LEFT JOIN episodes e ON e.id = t.source_episode_id
          WHERE t.status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
            AND (${shortTokens.map(() => '(t.title LIKE ? OR t.details LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`]), Math.min(limit, 4))
        for (const hit of likeTasks) {
          if (seen.has(`task:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(`task:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse tasks like', error) }
      try {
        const likePropositions = this.db.prepare(`
          SELECT 'proposition' AS type, p.proposition_kind AS subtype, CAST(p.id AS TEXT) AS ref,
                 p.text AS content, 0 AS score, unixepoch(p.last_seen) AS updated_at, p.id AS entity_id,
                 p.confidence AS quality_score, p.retrieval_count AS retrieval_count,
                 p.source_episode_id AS source_episode_id, p.source_fact_id AS source_fact_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM propositions p
          LEFT JOIN episodes e ON e.id = p.source_episode_id
          WHERE p.status = 'active'
            AND (${shortTokens.map(() => 'p.text LIKE ?').join(' OR ')})
          LIMIT ?
        `).all(...likeParams, Math.min(limit, 4))
        for (const hit of likePropositions) {
          if (seen.has(`proposition:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(`proposition:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse propositions like', error) }
      try {
        const likeSignals = this.db.prepare(`
          SELECT 'signal' AS type, s.kind AS subtype, CAST(s.id AS TEXT) AS ref,
                 s.value AS content, 0 AS score, unixepoch(s.last_seen) AS updated_at, s.id AS entity_id,
                 s.retrieval_count AS retrieval_count, s.score AS quality_score,
                 s.source_episode_id AS source_episode_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM signals s
          LEFT JOIN episodes e ON e.id = s.source_episode_id
          WHERE (${shortTokens.map(() => '(s.kind LIKE ? OR s.value LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`]), Math.min(limit, 3))
        for (const hit of likeSignals) {
          if (seen.has(`signal:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(`${hit.subtype ?? ''} ${hit.content}`, shortTokens)
          results.push(hit)
          seen.add(`signal:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse signals like', error) }
      try {
        const likeProfiles = this.db.prepare(`
          SELECT 'profile' AS type, key AS subtype, key || ': ' || value AS content,
                 0 AS score, unixepoch(last_seen) AS updated_at, 0 AS entity_id,
                 confidence AS quality_score, retrieval_count
          FROM profiles
          WHERE status = 'active'
            AND (${shortTokens.map(() => '(key LIKE ? OR value LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`]), Math.min(limit, 2))
        for (const hit of likeProfiles) {
          const profileKey = `profile:${hit.subtype}`
          if (seen.has(profileKey)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(profileKey)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse profiles like', error) }
    }

    return results
  }

  async searchRelevantDense(query, limit = 8, queryVector = null, focusVector = null, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const vector = queryVector ?? await embedText(clean)
    const includeDoneTasks = Boolean(options.includeDoneTasks)
    if (!Array.isArray(vector) || vector.length === 0) return []
    const model = getEmbeddingModelId()
    const expectedDims = getEmbeddingDims()
    const vectorModel = this.getMetaValue('embedding.vector_model', '')
    const vectorDims = Number(this.getMetaValue('embedding.vector_dims', '0')) || 0
    const reindexRequired = this.getMetaValue('embedding.reindex_required', '0') === '1'
    const reindexReason = this.getMetaValue('embedding.reindex_reason', '')
    const hasCurrentModelVectors = Boolean(this.hasVectorModelStmt.get(model)?.ok)
    if (reindexRequired) {
      process.stderr.write(`[memory] dense retrieval disabled: embeddings require reindex (${reindexReason || 'provider/model switch'})\n`)
      return []
    }
    if (vectorModel && vectorModel !== model && !hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: current model=${model} indexed model=${vectorModel}; rebuild embeddings required\n`)
      return []
    }
    if (expectedDims && vector.length !== expectedDims) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} expected=${expectedDims}\n`)
      return []
    }
    if (vectorDims && vector.length !== vectorDims && hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} indexed dims=${vectorDims}\n`)
      return []
    }

    // sqlite-vec KNN path
    if (this.vecEnabled) {
      try {
        const hex = vecToHex(vector)
        const knnRows = this.db.prepare(`
          SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?
        `).all(limit * 3)

        const results = []
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          const meta = this._getEntityMeta(entityType, entityId, model, { includeDoneTasks })
          if (!meta) continue
          const similarity = 1 - knn.distance  // L2 distance → approximate similarity
          const focusSimilarity = Array.isArray(focusVector) ? (() => {
            try {
              const rv = JSON.parse(meta.vector_json)
              return rv.length === focusVector.length ? cosineSimilarity(focusVector, rv) : 0
            } catch { return 0 }
          })() : 0
          results.push({
            ...meta,
            ref: String(entityId),
            score: -similarity,
            focus_similarity: focusSimilarity,
          })
        }
        return results.sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit)
      } catch (e) {
        process.stderr.write(`[memory] vec KNN failed, falling back: ${e.message}\n`)
      }
    }

    // Fallback: JS cosine scan
    const rows = [
      ...this.listDenseFactRowsStmt.all(model),
      ...(includeDoneTasks ? this.listDenseTaskRowsWithDoneStmt.all(model) : this.listDenseTaskRowsStmt.all(model)),
      ...this.listDenseSignalRowsStmt.all(model),
      ...this.listDensePropositionRowsStmt.all(model),
      ...this.listDenseEpisodeRowsStmt.all(model),
      ...this.listDenseEntityRowsStmt.all(model),
      ...this.listDenseRelationRowsStmt.all(model),
    ]

    return rows
      .map(row => {
        try {
          const rowVector = JSON.parse(row.vector_json)
          const similarity = cosineSimilarity(vector, rowVector)
          const focusSimilarity =
            Array.isArray(focusVector) && focusVector.length === rowVector.length
              ? cosineSimilarity(focusVector, rowVector)
              : 0
          return {
            ...row,
            ref: String(row.entity_id),
            score: -similarity,
            focus_similarity: focusSimilarity,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.score) - Number(b.score))
      .slice(0, limit)
  }

  _getEntityMeta(entityType, entityId, model, options = {}) {
    try {
      const includeDoneTasks = Boolean(options.includeDoneTasks)
      if (entityType === 'fact') {
        return this.db.prepare(`
          SELECT 'fact' AS type, f.fact_type AS subtype, f.id AS entity_id, f.text AS content,
                 unixepoch(f.last_seen) AS updated_at, f.retrieval_count AS retrieval_count,
                 f.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM facts f
          JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = f.source_episode_id
          WHERE f.id = ? AND f.status = 'active'
        `).get(model, entityId)
      }
      if (entityType === 'task') {
        return this.db.prepare(`
          SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id,
                 trim(t.title || CASE WHEN t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
                 unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
                 t.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM tasks t
          JOIN memory_vectors mv ON mv.entity_type = 'task' AND mv.entity_id = t.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = t.source_episode_id
          WHERE t.id = ? AND t.status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
        `).get(model, entityId)
      }
      if (entityType === 'signal') {
        return this.db.prepare(`
          SELECT 'signal' AS type, s.kind AS subtype, s.id AS entity_id, s.value AS content,
                 unixepoch(s.last_seen) AS updated_at, s.retrieval_count AS retrieval_count,
                 s.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM signals s
          JOIN memory_vectors mv ON mv.entity_type = 'signal' AND mv.entity_id = s.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = s.source_episode_id
          WHERE s.id = ?
        `).get(model, entityId)
      }
      if (entityType === 'proposition') {
        return this.db.prepare(`
          SELECT 'proposition' AS type, p.proposition_kind AS subtype, p.id AS entity_id, p.text AS content,
                 unixepoch(p.last_seen) AS updated_at, p.retrieval_count AS retrieval_count,
                 p.source_fact_id AS source_fact_id,
                 p.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM propositions p
          JOIN memory_vectors mv ON mv.entity_type = 'proposition' AND mv.entity_id = p.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = p.source_episode_id
          WHERE p.id = ? AND p.status = 'active'
        `).get(model, entityId)
      }
      if (entityType === 'episode') {
        return this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 e.created_at AS updated_at, 0 AS retrieval_count,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM episodes e JOIN memory_vectors mv ON mv.entity_type = 'episode' AND mv.entity_id = e.id AND mv.model = ?
          WHERE e.id = ?
            AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
        `).get(model, entityId)
      }
      if (entityType === 'entity') {
        return this.db.prepare(`
          SELECT 'entity' AS type, en.entity_type AS subtype, en.id AS entity_id,
                 trim(en.name || CASE WHEN en.description IS NOT NULL AND en.description != '' THEN ' — ' || en.description ELSE '' END) AS content,
                 unixepoch(en.last_seen) AS updated_at, 0 AS retrieval_count,
                 NULL AS source_kind, NULL AS source_backend,
                 mv.vector_json
          FROM entities en
          JOIN memory_vectors mv ON mv.entity_type = 'entity' AND mv.entity_id = en.id AND mv.model = ?
          WHERE en.id = ?
        `).get(model, entityId)
      }
      if (entityType === 'relation') {
        return this.db.prepare(`
          SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
                 trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
                 unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
                 NULL AS source_kind, NULL AS source_backend,
                 mv.vector_json
          FROM relations r
          JOIN entities se ON se.id = r.source_entity_id
          JOIN entities te ON te.id = r.target_entity_id
          JOIN memory_vectors mv ON mv.entity_type = 'relation' AND mv.entity_id = r.id AND mv.model = ?
          WHERE r.id = ? AND r.status = 'active'
        `).get(model, entityId)
      }
    } catch {}
    return null
  }

  combineRetrievalResults(query, sparseResults, denseResults, limit = 8, intent = null, queryEntities = [], options = {}) {
    const now = Date.now()
    const merged = new Map()
    const queryTokens = new Set(tokenizeMemoryText(query))
    const queryTokenCount = queryTokens.size
    const tuning = options.tuning ?? this.getRetrievalTuning()
    const weightConfig = tuning?.weights ?? DEFAULT_MEMORY_TUNING.weights
    const primaryIntent = intent?.primary ?? 'decision'
    const profileSlot = primaryIntent === 'profile' ? detectProfileQuerySlot(query) : ''
    const devBiasConfig = tuning?.devBias ?? DEFAULT_MEMORY_TUNING.devBias
    const devBias = Number(intent?.devBias ?? detectDevQueryBias(query))
    const isDevQuery = devBias >= Number(devBiasConfig.queryThreshold ?? 0.3)
    const effectiveIntent = options.graphFirst ? 'graph' : primaryIntent
    const includeDoneTasks = isDoneTaskQuery(query)
    const ongoingTaskQuery = Boolean(options.preferActiveTasks) || isOngoingTaskQuery(query)
    const explicitRelationQuery = isRelationQuery(query)

    // Entity-filtered retrieval: find matching entities and collect their source episode IDs
    const scopedEntityIds = new Set(queryEntities.map(item => Number(item.id)).filter(Number.isFinite))
    const scopedEntityNames = new Set(queryEntities.map(item => String(item.name ?? '').toLowerCase()).filter(Boolean))

    const dedupKey = (item) => {
      const entityId = Number(item?.entity_id ?? 0)
      if (entityId > 0) {
        const status = String(item?.status ?? '')
        const workstream = String(item?.workstream ?? '')
        return `${item.type}:${item.subtype}:${entityId}:${status}:${workstream}`
      }
      const normalized = cleanMemoryText(String(item.content ?? '')).toLowerCase()
      const contentHash = createHash('sha1').update(normalized.slice(0, 240)).digest('hex').slice(0, 16)
      return `${item.type}:${item.subtype}:${contentHash}`
    }

    for (const item of sparseResults) {
      const key = dedupKey(item)
      merged.set(key, {
        ...item,
        sparse_score: Number(item.score),
        dense_score: null,
      })
    }

    for (const item of denseResults) {
      const key = dedupKey(item)
      const prev = merged.get(key)
      if (prev) {
        prev.dense_score = Number(item.score)
      } else {
        merged.set(key, {
          ...item,
          sparse_score: null,
          dense_score: Number(item.score),
        })
      }
    }

    const scored = [...merged.values()]
      .map(item => {
        const sparse = item.sparse_score ?? 0
        const dense = item.dense_score ?? 0
        const ageSeconds = item.updated_at ? Math.max(0, now / 1000 - Number(item.updated_at)) : 0
        // Ebbinghaus-inspired decay: rapid initial forgetting, then plateau
        // R = e^(-t/S) where S scales with retrieval_count (spaced repetition)
        const ageDays = ageSeconds / 86400
        const recencyCfg = weightConfig.recency ?? DEFAULT_MEMORY_TUNING.weights.recency
        const overlapCfg = weightConfig.overlap ?? DEFAULT_MEMORY_TUNING.weights.overlap
        const retrievalCfg = weightConfig.retrieval ?? DEFAULT_MEMORY_TUNING.weights.retrieval
        const focusCfg = weightConfig.focus ?? DEFAULT_MEMORY_TUNING.weights.focus
        const qualityCfg = weightConfig.quality ?? DEFAULT_MEMORY_TUNING.weights.quality
        const densityCfg = weightConfig.densityPenalty ?? DEFAULT_MEMORY_TUNING.weights.densityPenalty
        const entityCfg = weightConfig.entityBoost ?? DEFAULT_MEMORY_TUNING.weights.entityBoost
        const doneTaskCfg = weightConfig.doneTask ?? DEFAULT_MEMORY_TUNING.weights.doneTask
        const taskStageCfg = weightConfig.taskStagePenalty ?? DEFAULT_MEMORY_TUNING.weights.taskStagePenalty
        const relationCfg = weightConfig.relationPenalty ?? DEFAULT_MEMORY_TUNING.weights.relationPenalty
        const stabilityFactor = 1 + Math.min(Number(recencyCfg.maxRetrievalFactor ?? 5), Number(item.retrieval_count ?? 0)) * Number(recencyCfg.stabilityStep ?? 0.8)
        const recencyPenalty = Math.min(
          Number(recencyCfg.maxPenalty ?? 0.4),
          (1 - Math.exp(-ageDays / (stabilityFactor * Number(recencyCfg.windowDays ?? 15)))) * Number(recencyCfg.maxPenalty ?? 0.4),
        )
        const contentTokens = tokenizeMemoryText(`${item.subtype ?? ''} ${item.content}`)
        const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
        const overlapRatio = queryTokenCount > 0 ? overlapCount / queryTokenCount : 0
        const overlapCap =
          isPolicyIntent(primaryIntent) ? Number(overlapCfg.policyMax ?? 0.42) :
          (primaryIntent === 'event' || primaryIntent === 'history') ? Number(overlapCfg.historyMax ?? 0.34) :
          Number(overlapCfg.defaultMax ?? 0.26)
        const overlapBoost =
          overlapCount > 0
            ? -Math.min(overlapCap, overlapRatio * overlapCap)
            : 0
        const retrievalBoost = -Math.min(Number(retrievalCfg.maxBoost ?? 0.08), Number(item.retrieval_count ?? 0) * Number(retrievalCfg.step ?? 0.01))
        const focusBoost =
          primaryIntent === 'task' || primaryIntent === 'decision'
            ? -Math.min(Number(focusCfg.maxBoost ?? 0.14), Math.max(0, Number(item.focus_similarity ?? 0)) * Number(focusCfg.multiplier ?? 0.12))
            : 0
        const qualityBoost =
          item.type === 'fact' || item.type === 'task' || item.type === 'relation' || item.type === 'proposition'
            ? -Math.min(Number(qualityCfg.strongMax ?? 0.12), Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * Number(qualityCfg.strongMultiplier ?? 0.3))
            : item.type === 'signal' || item.type === 'profile' || item.type === 'entity'
              ? -Math.min(Number(qualityCfg.lightMax ?? 0.08), Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * Number(qualityCfg.lightMultiplier ?? 0.2))
              : 0
        const typeBoost = getConfiguredTypeBoost(item, tuning)
        let intentBoost = getConfiguredIntentBoost(primaryIntent, item, tuning)
        if (primaryIntent === 'task' && ongoingTaskQuery && item.type === 'task' && String(item.stage ?? '').toLowerCase() === 'planned') {
          intentBoost += Number(tuning?.taskSeed?.ongoingQuery?.plannedPenalty ?? DEFAULT_MEMORY_TUNING.taskSeed.ongoingQuery.plannedPenalty)
        }
        const profileSlotBoost =
          primaryIntent === 'profile'
            ? getProfileSlotRankAdjustment(profileSlot, item)
            : 0
        const densityPenalty =
          item.type === 'signal' && overlapCount === 0 ? Number(densityCfg.signalNoOverlap ?? 0.12) :
          item.type === 'episode' && overlapCount === 0 ? Number(densityCfg.episodeNoOverlap ?? 0.10) :
          0
        // Entity boost: items linked to a matching entity get a score boost
        const entityBoost =
          scopedEntityIds.size > 0
            ? (
                item.type === 'entity' && scopedEntityIds.has(Number(item.entity_id)) ? Number(entityCfg.entityMatch ?? -0.28) :
                item.type === 'relation' && [...scopedEntityNames].some(name => String(item.content ?? '').toLowerCase().includes(name)) ? Number(entityCfg.relationMatch ?? -0.24) :
                item.scoped_entity_id && scopedEntityIds.has(Number(item.scoped_entity_id)) ? Number(entityCfg.scopedMatch ?? -0.26) :
                0
              )
            : 0
        const sourceTrustBoost = computeSourceTrustAdjustment(item, effectiveIntent)
        const doneTaskBoost =
          item.type === 'task'
            ? (
                includeDoneTasks && item.status === 'done' ? Number(doneTaskCfg.doneBoost ?? -0.42) :
                includeDoneTasks && (item.status === 'active' || item.status === 'in_progress') ? Number(doneTaskCfg.activePenalty ?? 0.28) :
                0
              )
            : 0
        const taskStagePenalty =
          item.type === 'task'
            ? (
                item.stage === 'planned' ? Number(taskStageCfg.planned ?? 0.12) :
                item.stage === 'investigating' ? Number(taskStageCfg.investigating ?? 0.06) :
                item.stage === 'implementing' ? Number(taskStageCfg.implementing ?? -0.03) :
                item.stage === 'wired' ? Number(taskStageCfg.wired ?? -0.02) :
                item.stage === 'verified' ? Number(taskStageCfg.verified ?? -0.01) :
                0
              )
            : 0
        const relationPenalty =
          !explicitRelationQuery && (item.type === 'relation' || item.type === 'entity')
            ? Number(relationCfg.default ?? 0.12)
            : 0
        const devWorkstreamPenalty =
          item.workstream
            ? (
                isDevQuery && isDevWorkstream(item.workstream, item.content)
                  ? -Number(devBiasConfig.workstreamBoost ?? 0.2)
                  : (!isDevQuery && isDevWorkstream(item.workstream, item.content)
                      ? Number(devBiasConfig.generalSuppress ?? 0.6)
                      : 0)
              )
            : 0
        return {
          ...item,
          content: compactRetrievalContent(item),
          overlapCount,
          weighted_score: sparse + dense + recencyPenalty + typeBoost + intentBoost + profileSlotBoost + overlapBoost + retrievalBoost + focusBoost + qualityBoost + densityPenalty + entityBoost + sourceTrustBoost + doneTaskBoost + taskStagePenalty + relationPenalty + devWorkstreamPenalty,
        }
      })
    const positiveCoreMatches = scored.filter(item =>
      Number(item.overlapCount) > 0 &&
      (item.type === 'fact' || item.type === 'task'),
    ).length
    const hasPositiveOverlap = scored.some(item => Number(item.overlapCount) > 0)
    const ranked = collapseClaimSurfaceDuplicates(scored, 'weighted_score')
      .map(item => {
        const overlapAdjustment =
          Number(item.overlapCount) > 0
            ? -Math.min(0.2, Number(item.overlapCount) * 0.06)
            : hasPositiveOverlap ? 0.28 : 0.08
        return {
          ...item,
          weighted_score: Number(item.weighted_score) + overlapAdjustment,
        }
      })
      .filter(item => {
        if (positiveCoreMatches < 2) return true
        if (Number(item.overlapCount) > 0) return true
        return item.type === 'signal'
      })
      .sort((a, b) => Number(a.weighted_score) - Number(b.weighted_score))

    const hasCoreResult = ranked.some(item => item.type === 'fact' || item.type === 'task')
    const conciseQuery = queryTokenCount <= 4
    const hasTaskCandidate = ranked.some(item => item.type === 'task')
    const hasDecisionLikeCore = ranked.some(item =>
      (item.type === 'fact' && (item.subtype === 'decision' || item.subtype === 'constraint')) ||
      item.type === 'proposition',
    )
    const typeCaps = getIntentTypeCaps(effectiveIntent, { hasTaskCandidate, hasCoreResult, conciseQuery })
    const typeCounts = new Map()
    const selected = []
    const rerankThreshold = getSecondStageThreshold(effectiveIntent, tuning?.secondStageThreshold)
    const rerankPool = collapseClaimSurfaceDuplicates(ranked.slice(0, Math.max(limit * 2, 10)), 'rerank_score')
      .map(item => {
        return {
          ...item,
          rerank_score: Number(item.weighted_score) + getIntentSubtypeBonus(effectiveIntent, item),
        }
      })
      .filter(item => shouldKeepRerankItem(effectiveIntent, item, { hasTaskCandidate }))
      .map(item => ({
        ...item,
        second_stage_score: computeSecondStageRerankScore(effectiveIntent, item, {
          includeDoneTasks,
          graphFirst: Boolean(options.graphFirst),
          isHistoryExact: Boolean(parseTemporalHint(query)?.exact) && (primaryIntent === 'history' || primaryIntent === 'event'),
          exactDate: parseTemporalHint(query)?.start ?? '',
        }),
      }))
      .map(item => ({
        ...item,
        second_stage_score:
          effectiveIntent === 'decision' && hasDecisionLikeCore && item.type === 'task'
            ? Number(item.second_stage_score) + 0.12
            : Number(item.second_stage_score),
      }))
      .sort((a, b) => Number(a.second_stage_score) - Number(b.second_stage_score))

    for (const item of rerankPool) {
      const allowByOverlap = Number(item.overlapCount) > 0
      const allowBySparse =
        item.sparse_score != null &&
        Number(item.sparse_score) <= 0 &&
        (effectiveIntent === 'decision' || effectiveIntent === 'graph' || isPolicyIntent(effectiveIntent) || effectiveIntent === 'event' || effectiveIntent === 'history')
      if (Number(item.second_stage_score) > rerankThreshold && !allowByOverlap && !allowBySparse) continue
      const type = String(item.type)
      const cap = typeCaps.get(type) ?? 2
      const count = typeCounts.get(type) ?? 0
      if (count >= cap) continue
      selected.push(item)
      typeCounts.set(type, count + 1)
      if (selected.length >= limit) break
    }
    return selected
  }

  recordRetrieval(results = []) {
    const now = new Date().toISOString()
    const seen = new Set()
    for (const item of results) {
      const profileKey = String(item?.subtype ?? '').trim()
      const entityId = Number(item?.entity_id ?? item?.id)
      const dedupeKey =
        item?.type === 'profile'
          ? `profile:${profileKey}`
          : `${String(item?.type ?? '')}:${entityId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      if (item.type === 'profile' && profileKey) {
        this.bumpProfileRetrievalStmt.run(now, profileKey)
      } else if (!Number.isFinite(entityId) || entityId <= 0) {
        continue
      } else if (item.type === 'fact') {
        this.bumpFactRetrievalStmt.run(now, entityId)
      } else if (item.type === 'task') {
        this.bumpTaskRetrievalStmt.run(now, entityId)
      } else if (item.type === 'signal') {
        this.bumpSignalRetrievalStmt.run(now, entityId)
      } else if (item.type === 'proposition') {
        this.bumpPropositionRetrievalStmt.run(now, entityId)
      }
    }
  }

  async getCoreMemoryItems(query = '', intent = null, queryVector = null) {
    const queryTokens = new Set(tokenizeMemoryText(query))
    const primaryIntent = intent?.primary ?? 'decision'
    const vector = query ? (queryVector ?? await embedText(query)) : null
    // Profile hints removed — profiles are injected once at session start via context.md

    const coreFacts = this.db.prepare(`
      SELECT id, 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 10
    `).all()

    const coreSignals = this.db.prepare(`
      SELECT id, 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
      FROM signals
      WHERE kind IN ('language', 'tone')
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 6
    `).all()
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.confidence, item.last_seen, item.subtype),
      }))
      .filter(item => item.effectiveScore >= 0.45)

    const dedupe = new Set()
    const items = []
    const scopedCoreFacts =
      isProfileIntent(primaryIntent)
        ? coreFacts.filter(item => isProfileRelatedText(item.content))
        : coreFacts
    const combined = [...scopedCoreFacts, ...coreSignals]
    const semanticScores = vector
      ? await Promise.all(combined.map(async item => {
          const entityType = item.type === 'fact' ? 'fact' : 'signal'
          const itemVector = await this.getStoredVector(entityType, item.id, `${item.subtype} ${item.content}`)
          return cosineSimilarity(vector, itemVector)
        }))
      : combined.map(() => 0)

    for (let i = 0; i < combined.length; i += 1) {
      const item = combined[i]
      const key = `${item.type}:${item.subtype}:${item.content}`
      if (dedupe.has(key)) continue
      dedupe.add(key)
      const contentTokens = tokenizeMemoryText(`${item.subtype} ${item.content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
      const typeBoost =
        item.type === 'signal'
          ? (item.subtype === 'language' || item.subtype === 'tone' ? 2 : 1)
          : item.subtype === 'preference'
            ? 2
            : 1
      const intentBoost =
        isProfileIntent(primaryIntent)
          ? typeBoost
          : primaryIntent === 'task'
            ? (item.subtype === 'constraint' ? 1 : 0)
            : isPolicyIntent(primaryIntent)
              ? (item.subtype === 'constraint' ? 2 : item.subtype === 'preference' ? 1 : 0)
            : 0
      const semanticBoost = vector ? semanticScores[i] * 3 : 0
      items.push({
        ...item,
        overlapCount,
        rankScore: overlapCount * 3 + intentBoost + semanticBoost + Number(item.confidence ?? item.effectiveScore ?? 0.5),
      })
    }
    const limit =
      isProfileIntent(primaryIntent) ? 4 :
      isPolicyIntent(primaryIntent) ? 3 :
      primaryIntent === 'decision' ? 3 :
      primaryIntent === 'task' ? 1 :
      primaryIntent === 'history' ? 1 :
      2
    return items
      .filter(item => {
        // profile intent: only profile-shaped facts/signals
        if (isProfileIntent(primaryIntent)) return item.type === 'signal' || isProfileRelatedText(item.content)
        // others: require keyword overlap or semantic relevance
        return Number(item.overlapCount) > 0 || Number(item.rankScore) > 4.5
      })
      .sort((a, b) => Number(b.rankScore) - Number(a.rankScore))
      .slice(0, limit)
  }

  async getPriorityTasks(query = '', options = {}) {
    const queryVector = query ? await embedText(query) : []
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const workstreamHint = normalizeWorkstream(options.workstreamHint)
    const hintTokens = tokenizedWorkstream(workstreamHint)
    const includeDone = Boolean(options.includeDone) || isDoneTaskQuery(query)

    const rows = this.db.prepare(`
      SELECT id, title, details, workstream, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN (${includeDone ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
      LIMIT 12
    `).all()

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(`${row.title} ${row.details ?? ''}`)
      const taskVector = await this.getStoredVector('task', row.id, content)
      const querySimilarity =
        Array.isArray(queryVector) && queryVector.length === taskVector.length
          ? cosineSimilarity(queryVector, taskVector)
          : 0
      const focusSimilarity =
        Array.isArray(focusVector) && focusVector.length === taskVector.length
          ? cosineSimilarity(focusVector, taskVector)
          : 0
      const priorityBoost =
        row.priority === 'high' ? 0.35 :
        row.priority === 'normal' ? 0.18 :
        0
      const statusBoost =
        includeDone && row.status === 'done' ? 1.6 :
        includeDone && (row.status === 'active' || row.status === 'in_progress') ? -0.45 :
        row.status === 'active' || row.status === 'in_progress' ? 0.08 :
        0
      const stageBoost =
        row.stage === 'implementing' ? 0.42 :
        row.stage === 'wired' ? 0.34 :
        row.stage === 'verified' ? 0.24 :
        row.stage === 'investigating' ? 0.12 :
        row.stage === 'planned' ? -0.08 :
        row.stage === 'done' ? (includeDone ? 0.20 : -0.08) :
        0
      const workstreamMatch =
        hintTokens.length > 0
          ? tokenizedWorkstream(row.workstream).filter(token => hintTokens.includes(token)).length
          : 0
      const recencyBoost = Math.min(0.18, Number(row.retrieval_count ?? 0) * 0.01)
      return {
        ...row,
        priority_score: querySimilarity * 4 + focusSimilarity * 3 + priorityBoost + statusBoost + stageBoost + workstreamMatch * 1.2 + recencyBoost + Number(row.confidence ?? 0.5),
      }
    }))

    return scored
      .sort((a, b) => Number(b.priority_score) - Number(a.priority_score))
      .slice(0, Math.max(1, Number(options.limit ?? 3)))
  }

  async buildInboundMemoryContext(query, options = {}) {
    return buildInboundMemoryContextImpl(this, query, options)
  }
}

export function getMemoryStore(dataDir) {
  const key = resolve(dataDir)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new MemoryStore(key)
  stores.set(key, store)
  return store
}
