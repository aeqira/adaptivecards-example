import { Hono } from "hono";

type Bindings = Env & {
	adaptive_cards: R2Bucket;
};

const App = new Hono<{ Bindings: Bindings }>();

function getFileName(key: string) {
	return key.split("/").at(-1) ?? key;
}

App.get("/api/:cardName", async (c) => {
	const cardName = c.req.param("cardName");
	const bucket = c.env.adaptive_cards;

	if (!bucket) {
		return c.json({ error: "R2 binding \"adaptive_cards\" is not configured" }, 500);
	}

	const objectKeys = [
		`${cardName}.json`,
		cardName,
		`adaptive-card-variables/${cardName}.json`,
		`adaptive-card-variables/${cardName}`,
	];
	let cardObject: R2ObjectBody | null = null;
	let objectKey = "";

	for (const key of objectKeys) {
		cardObject = await bucket.get(key);
		if (cardObject) {
			objectKey = key;
			break;
		}
	}

	if (!cardObject) {
		const listedObjects = await bucket.list({ limit: 100 });
		const availableKeys = listedObjects.objects.map((object) => object.key);
		const discoveredKey = availableKeys.find((key) => {
			const fileName = getFileName(key);

			return (
				key === cardName ||
				key === `${cardName}.json` ||
				fileName === cardName ||
				fileName === `${cardName}.json`
			);
		});

		if (discoveredKey) {
			cardObject = await bucket.get(discoveredKey);
			objectKey = discoveredKey;
		}
	}

	if (!cardObject) {
		const listedObjects = await bucket.list({ limit: 25 });

		return c.json(
			{
				error: `Card "${cardName}" was not found`,
				checkedKeys: objectKeys,
				availableKeys: listedObjects.objects.map((object) => object.key),
			},
			404,
		);
	}

	try {
		const card = JSON.parse(await cardObject.text());

		return c.json({ card, objectKey });
	} catch {
		return c.json({ error: `Card "${objectKey}" is not valid JSON` }, 422);
	}
});

export default App;
