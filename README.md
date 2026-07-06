# git-commits-push

> [!NOTE]
> **Skill vs. Script** : l'Agent IA n'exécute **pas** les commits lui-même. Le `SKILL.md` lui ordonne de lancer un script TypeScript autonome (`turnlock-orchestrator.ts` + `turnlock-to-llm-bridge.ts`). Une fois lancé, le script prend le contrôle complet : découverte des repos, appels LLM via son propre bridge, opérations git, et reporting.

## Architecture

Le skill est orchestré par le moteur d'état **[Turnlock](https://github.com/earendil/w/turnlock)**, qui gère la persistance, la résumabilité, et le batch LLM.

```
git-commits-push/
├── SKILL.md                          ← Instruction pour l'agent Pi
├── system-prompt.md                  ← Prompt système injecté au LLM du skill
├── package.json                      ← Dépendances (turnlock, zod, llm-runtime)
│
├── src/
│   ├── config/
│   │   ├── settings.ts               ← Lecture + validation de settings.json
│   │   └── settings.json             ← Configuration (provider, modèle, paths...)
│   ├── entrypoints/
│   │   ├── turnlock-orchestrator.ts  ← Machine d'état principale (phases 1-5)
│   │   └── turnlock-to-llm-bridge.ts ← Bridge vers l'API LLM (auth, streaming)
│   ├── modules/
│   │   ├── auth-resolver.ts          ← Résolution du token API (env → auth.json → command)
│   │   ├── commit-message-validator.ts ← Validation Conventional Commits
│   │   ├── discovery.ts             ← Découverte des repos git avec changements
│   │   ├── error-classifier.ts      ← Classification des erreurs (validation/structural/race/git/network)
│   │   ├── errors.ts                ← Types d'erreurs typés (CommitPlanError, PartialCommitError, PushError…)
│   │   ├── fallback-model.ts        ← Escalade vers un modèle de secours
│   │   ├── feedback-formatter.ts    ← Formatage du feedback pour le LLM (retry context)
│   │   ├── git-publisher.ts         ← Commit + push avec split par fichier
│   │   ├── pre-commit-validators.ts ← Pipeline pré-commit : tests cascade + diff + secret scan
│   │   ├── queue-retry.ts           ← File de retry avec détection de boucle (plan hash)
│   │   ├── reporter.ts              ← Génération du rapport d'exécution
│   │   ├── secret-scanner.ts        ← Détection de secrets dans le diff (regex patterns)
│   │   └── skill-stats-log.ts       ← Logging structuré → events.jsonl (observabilité)
│   ├── types.ts                      ← Contrats de types partagés
│   └── utils/
│       └── git-utils.ts             ← Helpers git (dirty check, worktrees, detached HEAD…)
│
└── tests/                            ← Tests unitaires, invariants, propriétés, acceptance
```

## Cycle de vie

Le skill opère en **2 phases Turnlock**, chacune pouvant boucler sur elle-même en cas de retry.

### Phase 1 — `discovery-and-validation`

```
┌─────────────────────────────────────────────────────┐
│ 1. Découverte                                       │
│    Parcourt les searchPaths, trouve les repos git   │
│    avec des changements non commités.               │
│    Ignore les repos en detached HEAD.               │
├─────────────────────────────────────────────────────┤
│ 2. Validation pré-commit (par repo)                 │
│    a. Test cascade (STACK_EVAL.yaml →               │
│       package.json → bun test → pytest)             │
│    b. git add -A                                    │
│    c. Extraction du diff + calcul du diffHash       │
│    d. Secret scan (bloque si clé/token détecté)     │
├─────────────────────────────────────────────────────┤
│ 3. Délégation au LLM                                │
│    Envoie un batch de jobs au bridge LLM.           │
│    Chaque job contient le diff + system-prompt.md.  │
│    Passe la main à la phase commit-and-push.        │
└─────────────────────────────────────────────────────┘
```

### Phase 2 — `commit-and-push` (boucle de retry)

```
┌──────────────────────────────────────────────────────────┐
│ 4. Réception des résultats LLM                           │
│    Pour chaque repo :                                    │
│                                                          │
│    a. Classification LLM-side                            │
│       Si le LLM renvoie une erreur → classifyLLMFailure  │
│       → retry ou fail selon le budget.                   │
│                                                          │
│    b. Validation Conventional Commits                    │
│       Chaque message de commit est validé.               │
│       Si invalide → retry "validation" avec feedback.    │
│       Si budget épuisé → escalade fallback model.        │
│                                                          │
│    c. Exécution git                                      │
│       executeMultiCommitAndPush :                        │
│       • File-level splitting (un commit par groupe de    │
│         fichiers)                                        │
│       • git reset HEAD inter-commit                      │
│       • Détection de race (diffHash mismatch)            │
│       • Partial commits (SHAs déjà posés sont préservés) │
│                                                          │
│    d. Classification d'erreur                            │
│       classifyError → validation | structural | race    │
│       | git | network | success                          │
│       → retry (avec feedback) ou fail définitif.         │
│                                                          │
│    e. Détection de boucle                                │
│       Si le LLM renvoie un plan identique (même          │
│       planHash) deux fois de suite → FAILED.             │
│                                                          │
│    f. Si des retryJobs sont en attente → redélègue       │
│       au LLM et rappelle commit-and-push.                │
│       Sinon → Phase 5 (reporting).                       │
├──────────────────────────────────────────────────────────┤
│ 5. Reporting                                             │
│    Affiche le rapport final (✅/❌ par repo,              │
│    retries, fallback, SHAs commités).                    │
└──────────────────────────────────────────────────────────┘
```

## Système de retry

Le skill distingue **5 types d'erreur**, chacun avec son propre budget de tentatives (`MAX_ATTEMPTS_BY_KIND`) :

| Kind | Déclencheur | Action |
|---|---|---|
| `validation` | Message de commit ne respecte pas Conventional Commits | Retry avec feedback structuré → fallback model si budget épuisé |
| `structural` | Le LLM n'a pas produit de plan de commit valide (JSON malformé) | Retry avec l'erreur de parsing |
| `race` | Le diff a changé entre la validation et le commit (diffHash mismatch) | Retry avec le nouveau diff |
| `git` | Erreur git inattendue (hors push/race) | Retry après `git reset HEAD` |
| `network` | Échec de push (remote inaccessible) | Retry avec backoff |

Le **fallback model** (configuré dans `settings.json` : `fallbackProvider` / `fallbackModel`) est utilisé uniquement quand le budget de retry `validation` est épuisé. Il réinitialise le compteur pour donner une seconde chance avec un modèle plus puissant.

## Détection de boucle

Avant chaque retry, `queueRetry` hache le plan de commit précédent. Si le LLM renvoie le **même plan deux fois consécutivement**, le repo est marqué `FAILED` avec `loopDetected`. Cela évite les boucles infinies où le LLM persiste dans une erreur.

## Secret scanner

Le module `secret-scanner.ts` scanne chaque diff avant commit et bloque si l'un de ces patterns est détecté :

| Pattern | Exemple |
|---|---|
| AWS Access Key | `AKIA...` |
| AWS Secret Key | `aws_secret_access_key = ...` |
| Private Key | `[-BEGIN PRIVATE KEY-]` |
| GitHub Token | `ghp_...`, `gho_...`, `ghu_...`, `ghs_...`, `ghr_...` |
| Slack Token | `xoxb-...`, `xoxp-...` |
| Connection String | `mongo-db://user:pass@host` |
| Generic API Key | `api_key = "..."` |
| Generic Token | `auth_token = "..."` |
| Env Secrets | `OPENAI_API_KEY = ...`, `STRIPE_SECRET = ...` |
| Password/Secret | `pass_word = "..."` (avec filtre anti-faux-positifs : placeholders, variables d'env) |

Les faux positifs courants (`process.env.X`, `os.environ[...]`, `${VAR}`, `getenv()`) sont filtrés. Les blocages sont loggés dans `events.jsonl`.

## Test cascade

Avant de commiter, le skill exécute les tests du repo selon une cascade auto-découverte :

1. **`STACK_EVAL.yaml`** → champ `test_runner` (supporte `vitest`, `pytest`, `bun test`, `none`)
2. **`package.json`** → script `test` (détecte le package manager : `bun` > `pnpm` > `yarn` > `npm`)
3. **Auto-discovery** → `bun test` si fichiers `*.test.ts` / `*.spec.ts` présents
4. **Auto-discovery** → `pytest` si fichiers `test_*.py` / `*_test.py` présents
5. **Fallback** → succès silencieux si aucun test trouvé

Configurable via `skipTests: true` dans `settings.json`.

## Observabilité (skill-stats-log)

Le module `skill-stats-log.ts` logue tous les événements dans `~/neelopedia/stats/pi/git-commits-push/events.jsonl` :

| Event | Quand |
|---|---|
| `run_start` | Début d'un run (parentModel, skillModel, reposCount) |
| `delegation` | Chaque appel LLM (initial + retry, avec kind, attempt, diffHash) |
| `loop_detected` | Plan identique détecté deux fois de suite |
| `repo_outcome` | Résultat final par repo (status, committedShas, attempts) |
| `run_end` | Fin du run (durationMs, success/fail/retry/loop counts) |

## Configuration (`src/config/settings.json`)

| Champ | Type | Description |
|---|---|---|
| `searchPaths` | `string[]` | Dossiers racine pour la découverte de repos |
| `provider` | `string` | Provider LLM principal |
| `model` | `string` | Modèle LLM principal |
| `temperature` | `number` | Température pour les appels LLM |
| `systemPromptPath` | `string` | Chemin vers le prompt système |
| `autoPush` | `boolean` | Push automatique après commit |
| `skipTests` | `boolean` | Désactive la test cascade |
| `thinking` | `boolean` | Active le mode thinking/reasoning du LLM |
| `fallbackProvider` | `string` | Provider de secours (optionnel) |
| `fallbackModel` | `string` | Modèle de secours pour les retries validation |


## Artefacts

| Ressource | Emplacement |
|---|---|
| États Turnlock (runs) | `~/.turnlock/runs/git-commits-push-tl/<runId>/` |
| Stats d'exécution | `~/neelopedia/stats/pi/git-commits-push/events.jsonl` |
| Stats secret scanner | `~/neelopedia/stats/pi/secret-scanner/events.jsonl` |
