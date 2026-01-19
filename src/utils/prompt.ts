export async function waitForEnter(message: string) {
  console.log(message);

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });
}
