# Meesho – Return Shipments Scanner

A responsive web app (HTML, CSS, Vanilla JS) for scanning return shipment codes with optional Google Sheets sync.

## Files

| File        | Purpose                          |
|------------|-----------------------------------|
| `index.html` | App shell + screens              |
| `style.css`  | Layout & styling                 |
| `script.js`  | Scanner logic + Sheets sync URL  |

## Run locally

Open `index.html` in a browser, or use a local server (recommended for camera):

```bash
# Python 3
python -m http.server 8080
```

Then visit `http://localhost:8080`.

> Camera and `html5-qrcode` work best over **HTTPS** or **localhost**.

## Deploy on GitHub

### 1. Create a new repository on GitHub

1. Go to [github.com/new](https://github.com/new).
2. Name the repo (e.g. `meesho-return-scanner`).
3. Do **not** add a README/license if you already have files locally (avoids merge issues).
4. Create the repository.

### 2. Push this project from your PC

In PowerShell, from this folder:

```powershell
cd "D:\Kailash\Work\Meesho Code\New Meesho App"

git init
git add .
git commit -m "Initial commit: Meesho Return Shipments Scanner"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

Replace `YOUR_USERNAME` and `YOUR_REPO_NAME` with your GitHub username and repo name.

If GitHub asks for login, use a **Personal Access Token** as the password (Settings → Developer settings → Personal access tokens), or use **GitHub Desktop**.

### 3. Optional: GitHub Pages (free hosting)

1. Repo → **Settings** → **Pages**.
2. **Source**: Deploy from a branch.
3. Branch: **main**, folder: **/ (root)** → Save.
4. After a minute, the site will be at:  
   `https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/`

Your app must use **relative** asset paths (`./style.css`, `./script.js`) — this project already does.

### Google Sheets URL

Set `GOOGLE_SHEETS_WEB_APP_URL` in `script.js` to your deployed Apps Script URL.  
For a **public** repo, consider keeping that URL in a private fork or using environment-based config so the URL is not public.

## License

Use as needed for your project.
