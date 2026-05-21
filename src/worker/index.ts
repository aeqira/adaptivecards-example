import { Hono } from "hono";
const App = new Hono<{ Bindings: Env }>();

App.get("/api/:name", (c) => {
  const name = c.req.param("name");
  return c.json({ name });
});

export default App;
