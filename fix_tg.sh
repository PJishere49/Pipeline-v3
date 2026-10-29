#!/bin/bash
echo "--- Telegram Auto-Fix ---"

read -p "1. Paste your Bot Token: " TG_TOKEN
read -p "2. Paste your Chat ID: " TG_CHAT

# Strip any hidden spaces or newlines
TG_TOKEN=$(echo "$TG_TOKEN" | tr -d '[:space:]')
TG_CHAT=$(echo "$TG_CHAT" | tr -d '[:space:]')

echo "Testing Token..."
TOKEN_TEST=$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/getMe")

if [[ "$TOKEN_TEST" != *"\"ok\":true"* ]]; then
  echo "ERROR: Invalid Token. Telegram says:"
  echo "$TOKEN_TEST"
  exit 1
fi

echo "Token is VALID."

echo "Testing Chat ID..."
CHAT_TEST=$(curl -s "https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=Test+Message")

if [[ "$CHAT_TEST" != *"\"ok\":true"* ]]; then
  echo "ERROR: Invalid Chat ID or Bot lacks permission. Telegram says:"
  echo "$CHAT_TEST"
  exit 1
fi

echo "Chat ID is VALID. (Check your Telegram, you should see 'Test Message')"

echo "Updating GitHub Secrets..."
gh secret set TELEGRAM_BOT_TOKEN --body "$TG_TOKEN" -R PJishere49/Pipeline-v3
gh secret set TELEGRAM_CHAT_ID --body "$TG_CHAT" -R PJishere49/Pipeline-v3

echo "SUCCESS. Secrets updated. You are ready to run the pipeline."
