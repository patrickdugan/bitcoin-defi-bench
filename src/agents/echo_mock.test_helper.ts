// A mock model server that calls one skill, then echoes the skill's result, on every turn. With
// `send: "reference"` it answers a result with {"tool":"send"} instead of copying it.
import { createServer, type Server } from "node:http";
export async function echoSkillServer(skill: string, send: "copy" | "reference" = "copy"): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      calls += 1;
      const lastUser = body.messages[body.messages.length - 1]!.content;
      let reply = JSON.stringify({ skill, args: {} });
      if (lastUser.startsWith("Result of skill")) reply = send === "copy" ? lastUser.split("\n")[1]! : '{"tool":"send"}';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply, reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls: () => calls };
}
