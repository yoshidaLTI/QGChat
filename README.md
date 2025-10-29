# QG Chat ― セットアップ手順

## 1. 事前準備
このシステムでは、講義動画から問題を自動生成する際に **ローカル LLM（Ollama）** を使用します。  
まず最初に Ollama を導入してください。
### Ollama のインストールとモデルのインストール
```bash
##ollama のインストール
curl -fsSL https://ollama.com/install.sh | sh
#modelは環境に合わせてインストール
ollama pull gpt-oss
```




#### 1-4. Python環境 のセットアップ
QG　Chat の問題生成処理はPythonで構築されています。  
そのためNode.js サーバとは別に Python 仮想環境を準備します。
```bash
## **QGChatディレクトリ直下で実行**
python3 -m venv .venv
source .venv/bin/activate
##pip のアップデート
pip install --upgrade pip
##ライブラリのインストール
pip install requests opencv-python pytesseract numpy pillow tqdm ffmpeg-python sentence-transformers chromadb
```
## 2. Node.js のセットアップ
QG Chat のサーバ部分は **Node.js (Express)** で構築されています。  
まず Node.js の実行環境を整えましょう。
```bash
cd server
npm init -y
npm install axios bcryptjs better-sqlite3 cookie-parser cors dotenv express jsonwebtoken multer
```
また、以下をpackage.jsonのデバック部に追加しておくよいでしょう
```bash
"scripts": {
  "dev": "node src/server.js"
},
```
### サーバ起動コマンド
```bash
cd server
npm run dev
```
## 3. ffmpeg & tesseract インストール
```bash
brew install ffmpeg
brew install tesseract
```
## 4. Whisperのセットアップ
### mlx_Whisperを推奨
```bash
pip install mlx-whisper
```