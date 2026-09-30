// consumer リポジトリに配置し、pages-login-script input で指定するサンプル。
// chromagic は default export を Playwright の page を渡して実行し、
// 完了後のブラウザ context から storage state を取得して以降のキャプチャに使う。
export default async function login(page) {
  await page.goto(`${process.env.CHROMAGIC_BASE_URL}/login`);
  await page.fill("#id", process.env.CHROMAGIC_LOGIN_ID);
  await page.fill("#password", process.env.CHROMAGIC_LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard");
}
