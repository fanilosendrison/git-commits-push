---
name: git-commits-push
description: Enforce Conventional Commits convention for writing commit messages, then auto-push. Use when the user asks how to write a commit, wants their message reviewed, needs to understand commit types, or asks about breaking changes. Triggers include "commit message", "conventional commits", "comment écrire un commit", "commit convention", "breaking change".
---

# Git Commits & Push

Messages de commit clairs, consistants et parseables — Conventional Commits 1.0.0.
**Après chaque commit, push automatiquement** vers le remote (sauf indication contraire
de l'utilisateur).

## Trigger

L'utilisateur a besoin d'aide avec les messages de commit. Signaux :
- "comment j'écris ce commit"
- "c'est quoi le bon type de commit pour ça"
- "revois mon message de commit"
- "conventional commits"
- "breaking change"

## Format

```
<type>(<scope>): <description>

[body]

[footer]
```

Trois parties : **subject line** (obligatoire), **body** (optionnel), **footer** (optionnel).

## Règles du subject line

1. **Toujours en anglais** — commits, body et footer inclus
2. **Type** — obligatoire, depuis la liste ci-dessous
3. **Scope** — optionnel, entre parenthèses, nomme le module/composant/service touché
4. **Description** — obligatoire, après `: `
5. **Impératif présent** : `add`, `fix`, `remove` — jamais `added`, `fixes`, `removing`
6. **Pas de majuscule** après le deux-points
7. **Pas de point** à la fin
8. **72 caractères max** pour le subject line entier

## Types autorisés

| Type | Quand l'utiliser |
|------|-----------------|
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `docs` | Documentation uniquement (README, comments, docstrings) |
| `style` | Formatage, whitespace, semicolons — pas de changement de logique |
| `refactor` | Restructuration de code sans changement fonctionnel |
| `perf` | Amélioration de performance |
| `test` | Ajout ou modification de tests |
| `build` | Build system ou dépendances externes |
| `ci` | Configuration CI/CD |
| `chore` | Tâches de maintenance qui ne touchent ni le source ni les tests |
| `revert` | Revert d'un commit précédent |

### Aide à la décision

Quand tu hésites sur le type :

- "J'ai ajouté un nouveau endpoint" → `feat`
- "J'ai fixé un crash" → `fix`
- "J'ai réécrit la fonction mais elle fait la même chose" → `refactor`
- "J'ai rendu ça plus rapide" → `perf`
- "J'ai ajouté un test" → `test`
- "J'ai mis à jour le README" → `docs`
- "J'ai lancé prettier" → `style`
- "J'ai upgradé une dépendance" → `build`
- "J'ai changé la config CI" → `ci`
- "J'ai nettoyé des vieux scripts" → `chore`

## Body

- Séparé du subject par **une ligne vide**
- Expliquer le **pourquoi**, pas le quoi (le diff montre le quoi)
- Wrap à **72 caractères**
- Peut avoir plusieurs paragraphes

## Footer

Utilisé pour :
- **Breaking changes** : `BREAKING CHANGE: <description>`
- **Références d'issues** : `Refs: GH-42` ou `Fixes: GH-108`

## Breaking Changes

Signaler avec **les deux** :
1. `!` après le type/scope dans le subject line
2. `BREAKING CHANGE:` dans le footer

```
feat(api)!: replace authentication endpoint schema

Migrate from form-encoded to JSON body for all auth endpoints.
This simplifies client implementations and aligns with the REST
convention used elsewhere in the API.

BREAKING CHANGE: The /auth/token endpoint now requires a JSON body
instead of form-encoded parameters. All existing clients must
update their request format before upgrading.

Refs: GH-256
```

## Exemples

### Feature

```
feat(auth): add OAuth2 authorization code flow with PKCE

Implements the full authorization code flow with PKCE for
third-party identity providers. Includes token refresh,
revocation, and session binding.

Refs: GH-42
```

### Fix

```
fix(export): handle empty dataset without crashing

Exporting an empty dataset previously raised an unhandled
IndexError. Now returns an empty file and logs a warning.

Fixes: GH-108
```

### Minimal (pas de body, pas de footer)

```
docs: add contributing guidelines
```

```
chore(deps): bump express from 4.18.2 to 4.19.0
```

### Revert

```
revert: feat(auth): add OAuth2 provider support

This reverts commit a1b2c3d4.
Reason: regression on session management under load.
```

## Anti-patterns à rejeter

```
# ❌ Passé
feat(auth): added OAuth2 support

# ❌ Majuscule après le deux-points
feat(auth): Add OAuth2 support

# ❌ Point à la fin
feat(auth): add OAuth2 support.

# ❌ Pas de type
add OAuth2 support

# ❌ Trop vague
fix: fix bug
chore: updates
feat: stuff

# ❌ Plusieurs concerns dans un commit
feat(auth): add OAuth2 and fix export crash and update README
```

## Auto-push

Après chaque `git commit` réussi, **toujours enchaîner avec `git push`** vers la branche
courante du remote.

- Si la branche n'a pas d'upstream → `git push -u origin <branch>`
- Si la branche a déjà un upstream → `git push`
- **Exception** : l'utilisateur dit explicitement "ne push pas" ou "commit only"
- Si le push échoue → signaler l'erreur, ne pas retry en boucle

## Guidelines

- **Ne jamais committer du code qui ne passe pas les tests** — lancer les tests avant
  tout commit. Si un test échoue, corriger avant de committer.
- **Ne jamais committer de secrets, clés API, tokens ou mots de passe** — vérifier
  le diff avant de committer. Utiliser `.gitignore` et/ou `.env` pour les données sensibles.
- **Toujours vérifier le message de commit** contre toutes les règles avant de valider
- **Suggérer le bon type** quand l'utilisateur décrit ce qu'il a changé
- **Réécrire les messages vagues** en messages spécifiques — proposer une alternative concrète
- **Signaler les commits multi-concerns** et suggérer de les split
- **Ne jamais générer un message de commit sans comprendre le changement** — demander
  ce qui a changé si c'est pas clair
