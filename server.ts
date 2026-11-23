// Start: npm start   (reads .env). This is also the file Vercel runs (it must import fastify).
import Fastify, { type FastifyInstance } from "fastify";

/** Remove anything secret-looking from an error before showing it. */
function safeError(err: unknown): string {
  const e = err as Error;
  return [e?.message ?? String(err), ...(e?.stack ?? "").split("\n").slice(1, 4)]
    .join("\n")
    .replace(/postgres(ql)?:\/\/\S+/gi, "[database link hidden]")
    .replace(/\b(org_|sk-|npg_)[A-Za-z0-9_-]+/g, "[key hidden]");
}

let app: FastifyInstance;
let port = Number(process.env.PORT || 3000);
let message = "";
try {
  const started = await import("./startup.js");
  app = started.app;
  port = started.port;
  message = started.startMessage();
} catch (err) {
  // The app couldn't start (for example a missing setting). Show why, instead of a blank error page.
  const why = safeError(err);
  console.error("Startup failed:", why);
  app = Fastify();
  app.all("/*", async (_req, reply) =>
    reply.code(500).type("text/plain").send(`The receptionist app could not start.\n\n${why}\n\nFix the setting above in Vercel -> Settings -> Environment Variables, then redeploy.`),
  );
}

// Don't wait for listen(): on Vercel the platform takes over the server and listen() never "finishes".
app.listen({ port, host: "0.0.0.0" }).then(
  () => { if (message) app.log.info(message); },
  (err) => { console.error("Could not start the server:", err.message); process.exit(1); },
);
