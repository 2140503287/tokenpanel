#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# TokenPanel Android/Termux bootstrap helper.
# This is for local development/testing only; it does not expose the app publicly.

if [ "$(uname -o 2>/dev/null || true)" != "Android" ] && [ ! -d /data/data/com.termux ]; then
  echo "This helper is intended for Termux on Android."
  exit 1
fi

pkg update -y
pkg install -y git curl unzip proot-distro

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if [ ! -d "$HOME/tokenpanel" ]; then
  git clone --branch chatgpt-wechat-alipay-token-billing https://github.com/2140503287/tokenpanel.git "$HOME/tokenpanel"
fi

cd "$HOME/tokenpanel"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

bun install

cat <<'EOF'

TokenPanel source is ready in ~/tokenpanel.

IMPORTANT:
- MongoDB is still required by the application.
- Static QR-code payments cannot provide reliable automatic settlement.
- Real WeChat/Alipay automatic settlement requires merchant credentials and a public HTTPS callback URL.
- Do not put payment private keys into Git or send them in chat.

Next steps:
  cd ~/tokenpanel
  bun run dev

Then open the local URL printed by the project in your Android browser.
EOF
