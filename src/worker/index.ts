import { Hono } from "hono";
const app = new Hono<{ Bindings: Env }>();

app.get("/api/:name", (c) => {
  const name = c.req.param("name");
  return c.json({ name });
});

export default app;
