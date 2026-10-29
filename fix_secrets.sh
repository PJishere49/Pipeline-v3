REPO="PJishere49/Pipeline-v3"

for name in BRAVE_API_KEY GH_PAT; do
  echo ""
  echo "=== NEXT SECRET: $name ==="
  read -s -p "Paste the key and press Enter: " SECRET_VAL
  echo ""
  gh secret set "$name" -R "$REPO" --body "$SECRET_VAL"
done
