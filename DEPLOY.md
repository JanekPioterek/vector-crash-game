# Deploying VECTOR to GitHub + Vercel

These commands run in a Terminal on your own Mac (not in Claude) since pushing to GitHub and deploying need your own credentials.

## 0. Open a terminal in the project folder

Easiest way: in Finder, navigate to this folder, then right-click it → **New Terminal at Folder**.

Or type the path directly:

```bash
cd "/Users/a0158bgl/Library/Application Support/Claude/local-agent-mode-sessions/03344895-53e3-4e7f-8439-e1941192dde4/da01dd61-bba6-4910-b537-ec6e40f31c24/local_aff76090-9804-481d-ae75-befe4c85101f/outputs"
```

You should see `index.html`, `styles.css`, and `script.js` here (`ls` to confirm).

## 1. Initialize git and commit

```bash
git init
git branch -M main
git add index.html styles.css script.js
git commit -m "VECTOR: sci-fi crash game prototype"
```

If there's a leftover empty `.git` folder here from earlier, `git init` is safe to run again — it just re-links the existing repo, nothing is lost.

## 2. Push to GitHub

**Option A — GitHub CLI (`gh`), if you have it installed:**

```bash
gh auth login          # only needed once, follow the prompts
gh repo create vector-crash-game --public --source=. --remote=origin --push
```

That single `gh repo create` line creates the repo on GitHub, adds it as `origin`, and pushes in one shot.

**Option B — no `gh` CLI:**

1. Go to [github.com/new](https://github.com/new), name it `vector-crash-game`, leave it empty (no README/gitignore), click **Create repository**.
2. Copy the commands GitHub shows you, or run:

```bash
git remote add origin https://github.com/<your-username>/vector-crash-game.git
git push -u origin main
```

## 3. Deploy to Vercel

**Option A — via the Vercel dashboard (recommended, no CLI needed):**

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import the `vector-crash-game` GitHub repo.
3. Framework preset: leave as **Other** (it's plain HTML/CSS/JS, no build step needed).
4. Click **Deploy**.

Vercel auto-detects `index.html` at the root and serves it directly. Every future `git push` to `main` will auto-deploy.

**Option B — via the Vercel CLI:**

```bash
npm install -g vercel
vercel login           # follow the prompts
vercel                 # first run: link/create the project, deploys a preview
vercel --prod           # promote to your production URL
```

Either path gives you a live `https://vector-crash-game-<hash>.vercel.app` URL (or your chosen domain) within a minute or two.
