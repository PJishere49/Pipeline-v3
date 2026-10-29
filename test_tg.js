const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function test() {
  console.log("Testing Telegram...");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: "Test from GitHub Actions!" })
  });
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}
test();
