import { Hono } from "hono";

const App = new Hono<{ Bindings: Env }>();

App.get("/api/:cardName", async (c) => {
  const cardName = c.req.param("cardName");

  const stateFile = await c.env.adaptive_cards.get("states.json");
  const cardFile = await c.env.adaptive_cards.get(`${cardName}.json`);

  const states = await stateFile?.json();
  const card = await cardFile?.json();

  return c.json({
    states,
    card,
  });
});

export default App;
