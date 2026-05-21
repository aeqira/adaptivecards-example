import { Hono } from "hono";

type Bindings = Env & {
	adaptive_cards: R2Bucket;
};

const App = new Hono<{ Bindings: Bindings }>();

App.get("/api/:cardName", async (c) => {
	const cardName = c.req.param("cardName");

	const cardObject = await c.env.adaptive_cards.get(`${cardName}.json`);
	if (!cardObject) {
		return c.json({ error: `Card "${cardName}" was not found` }, 404);
	}

	const card = JSON.parse(await cardObject.text());

	return c.json({ card });
});

export default App;
