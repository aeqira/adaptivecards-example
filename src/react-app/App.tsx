import { Hono } from "hono";
import ACData from "adaptivecards-templating";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/render-card", async (c) => {
  const cardObject = await c.env.adaptive_cards.get("member-payment-card.json");
  const statesObject = await c.env.adaptive_cards.get("states.json");
  const varsObject = await c.env.adaptive_cards.get("member-payment.json");

  if (!cardObject || !statesObject || !varsObject) {
    return c.json({ error: "Missing file in R2" }, 404);
  }

  const cardTemplateJson = await cardObject.json();
  const states = await statesObject.json();
  const vars = await varsObject.json();

  const data = {
    States: states,
    Vars: vars,
  };

  const template = new ACData.Template(cardTemplateJson);
  const renderedCard = template.expand({ $root: data });

  return c.json(renderedCard);
});

export default app;
