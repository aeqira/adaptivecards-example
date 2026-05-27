import { Hono, type Context } from "hono";
import * as ACData from "adaptivecards-templating";

type Bindings = Env & {
	adaptive_cards: D1Database;
	adaptive_card_variables: R2Bucket;
};

type CardRow = {
	data: string | null;
	payload: string;
};

type BindingSpec =
	| {
			key: string;
			name: string;
			type: "r2";
	  }
	| {
			name: string;
			query: string;
			type: "d1";
	  };

type SubmittedCardData = Record<string, unknown>;
type SubmissionRow = Record<string, unknown>;

const app = new Hono<{ Bindings: Bindings }>();
type AppContext = Context<{ Bindings: Bindings }>;
const bindingPattern = /\$\{([A-Za-z0-9_.\-[\]]+)\}/g;
const rootReferencePattern = /\$\{\s*\$root\[(?:"([^"]+)"|'([^']+)')\][^}]*\}/g;
const maxBindingsPerCard = 50;
const maxBindingBytes = 256 * 1024;
const maxQueryRows = 100;
const maxTemplateExpansionPasses = 5;
const maxSubmissionBytes = 64 * 1024;
const fluentIconCdnBaseUrl = "https://cdn.jsdelivr.net/npm/@fluentui/svg-icons/icons/";
const iconReferencePrefix = "icon:";
const renderedIconSize = "50px";
const paymentDetailsCardName = "payment-details";

app.use("/api", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});

app.use("/api/*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});

function parseMaybeJson(value: unknown) {
	if (typeof value !== "string") {
		return value;
	}

	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function createId() {
	return crypto.randomUUID();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringValue(data: SubmittedCardData, key: string, maxLength = 255) {
	const value = data[key];

	if (value === undefined || value === null) {
		return undefined;
	}

	const stringValue = String(value).trim();

	return stringValue ? stringValue.slice(0, maxLength) : undefined;
}

function getNumberValue(data: SubmittedCardData, key: string) {
	const value = data[key];
	const numberValue = typeof value === "number" ? value : Number(value);

	return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getCurrencyString(data: SubmittedCardData, key: string) {
	const value = getNumberValue(data, key);

	return value === undefined ? undefined : value.toFixed(2);
}

function getBooleanValue(data: SubmittedCardData, key: string) {
	const value = data[key];

	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		return value.toLowerCase() === "true";
	}

	return undefined;
}

function removeUndefinedValues(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(removeUndefinedValues);
	}

	if (isObject(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, childValue]) => [key, removeUndefinedValues(childValue)])
				.filter(([, childValue]) => childValue !== undefined),
		);
	}

	return value;
}

function getExpirationDate(data: SubmittedCardData) {
	const value = getStringValue(data, "cardExpiration", 16);

	if (!value) {
		return undefined;
	}

	const digits = value.replace(/\D/g, "");

	if (/^\d{4}$/.test(digits)) {
		const month = digits.slice(0, 2);
		const year = digits.slice(2);

		return `20${year}-${month}`;
	}

	if (/^\d{6}$/.test(digits)) {
		const month = digits.slice(0, 2);
		const year = digits.slice(2);

		return `${year}-${month}`;
	}

	return value;
}

function getAuthorizeNetPayment(data: SubmittedCardData) {
	const dataDescriptor = getStringValue(data, "dataDescriptor", 255);
	const dataValue = getStringValue(data, "dataValue", 4096);

	if (dataDescriptor && dataValue) {
		return {
			opaqueData: {
				dataDescriptor,
				dataValue,
			},
		};
	}

	const cardNumber = getStringValue(data, "cardAccount", 32);
	const expirationDate = getExpirationDate(data);
	const cardCode = getStringValue(data, "cardCode", 8);

	if (!cardNumber && !expirationDate && !cardCode) {
		return undefined;
	}

	return {
		creditCard: removeUndefinedValues({
			cardCode,
			cardNumber,
			expirationDate,
		}),
	};
}

function getUserFields(data: SubmittedCardData, message: string | undefined) {
	return [
		{
			name: "message",
			value: message,
		},
		{
			name: "updateTemenosAddress",
			value: getBooleanValue(data, "updateTemenosAddress")?.toString(),
		},
		{
			name: "updateTemenosEmail",
			value: getBooleanValue(data, "Update Temenos Email")?.toString(),
		},
	].filter((field) => field.value !== undefined);
}

function shapePaymentSubmission(data: SubmittedCardData) {
	const email = getStringValue(data, "Member Email", 255);
	const firstName = getStringValue(data, "memberFirst", 100);
	const lastName = getStringValue(data, "memberLast", 100);
	const memberNumber = getStringValue(data, "memberNumber", 32);
	const message = getStringValue(data, "paymentMessage", 255);
	const payment = getAuthorizeNetPayment(data);
	const userField = getUserFields(data, message);

	return removeUndefinedValues({
		createTransactionRequest: {
			refId: memberNumber,
			transactionRequest: {
				amount: getCurrencyString(data, "paymentAmount"),
				billTo: {
					address: getStringValue(data, "memberStreet", 255),
					city: getStringValue(data, "memberCity", 100),
					country: "US",
					firstName,
					lastName,
					state: getStringValue(data, "memberState", 32),
					zip: getStringValue(data, "memberZipcode", 32),
				},
				customer: {
					email,
					id: memberNumber,
				},
				payment,
				transactionSettings: {
					setting: {
						settingName: "testRequest",
						settingValue: "false",
					},
				},
				transactionType: "authCaptureTransaction",
				userFields: userField.length > 0 ? { userField } : undefined,
			},
		},
	});
}

function shapeSubmissionColumns(data: SubmittedCardData) {
	return {
		amount: getNumberValue(data, "paymentAmount"),
		email: getStringValue(data, "Member Email", 255),
		firstName: getStringValue(data, "memberFirst", 100),
		lastName: getStringValue(data, "memberLast", 100),
		memberNumber: getNumberValue(data, "memberNumber"),
		message: getStringValue(data, "paymentMessage", 255),
	};
}

function hasPaymentSubmissionData(payment: unknown) {
	return isObject(payment) && Object.keys(payment).length > 0;
}

function toCamelCase(value: string) {
	return value
		.replace(/[^A-Za-z0-9]+(.)/g, (_, character: string) => character.toUpperCase())
		.replace(/^[A-Z]/, (character) => character.toLowerCase());
}

function shapeSubmissionLookupData(row: SubmissionRow) {
	const submission: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		const normalizedKey = toCamelCase(key);
		const parsedValue = key.toLowerCase() === "payment" ? parseMaybeJson(value) : value;

		submission[key] = parsedValue;
		submission[normalizedKey] = parsedValue;
	}

	return {
		payment: submission.payment,
		submission,
		...submission,
	};
}

function looksLikeCardPayload(value: unknown) {
	return isObject(value) && ("type" in value || "body" in value || "actions" in value);
}

function hasBindingExpression(value: string) {
	bindingPattern.lastIndex = 0;
	return bindingPattern.test(value);
}

function getIconReference(
	iconName: string,
	iconIndexes: Map<string, number>,
	nextIconIndex: { value: number },
) {
	const existingIndex = iconIndexes.get(iconName);
	const iconIndex = existingIndex ?? nextIconIndex.value;

	if (existingIndex === undefined) {
		iconIndexes.set(iconName, iconIndex);
		nextIconIndex.value += 1;
	}

	return `\${icon[${iconIndex}]}`;
}

function restoreIconTemplateReferences(
	value: unknown,
	iconIndexes = new Map<string, number>(),
	nextIconIndex = { value: 0 },
): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => restoreIconTemplateReferences(item, iconIndexes, nextIconIndex));
	}

	if (!isObject(value)) {
		return value;
	}

	const restoredValue = Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [
			key,
			restoreIconTemplateReferences(childValue, iconIndexes, nextIconIndex),
		]),
	);

	if (
		restoredValue.type === "Icon" &&
		typeof restoredValue.name === "string" &&
		!hasBindingExpression(restoredValue.name)
	) {
		restoredValue.name = getIconReference(restoredValue.name, iconIndexes, nextIconIndex);
	}

	if (
		typeof restoredValue.iconUrl === "string" &&
		restoredValue.iconUrl.startsWith(iconReferencePrefix) &&
		!hasBindingExpression(restoredValue.iconUrl)
	) {
		const iconName = restoredValue.iconUrl.slice(iconReferencePrefix.length);
		restoredValue.iconUrl = `${iconReferencePrefix}${getIconReference(
			iconName,
			iconIndexes,
			nextIconIndex,
		)}`;
	}

	return restoredValue;
}

function restoreD1CardTemplateReferences(value: unknown, data: Record<string, unknown>): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => restoreD1CardTemplateReferences(item, data));
	}

	if (!isObject(value)) {
		return value;
	}

	const restoredValue = Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [
			key,
			restoreD1CardTemplateReferences(childValue, data),
		]),
	);

	if (
		restoredValue.type === "Action.ShowCard" &&
		typeof restoredValue.title === "string" &&
		isObject(restoredValue.card) &&
		!("body" in restoredValue.card) &&
		!("actions" in restoredValue.card)
	) {
		const bindingName = toSnakeCase(restoredValue.title).replace(/_/g, "-");
		const cardPayload = data[bindingName];

		if (looksLikeCardPayload(cardPayload)) {
			restoredValue.card = `\${$root[${JSON.stringify(bindingName)}]}`;
		}
	}

	return restoredValue;
}

function toSnakeCase(value: string) {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function isSafeImageUrl(value: string) {
	return (
		value.startsWith("https://") ||
		/^data:image\/(?:png|gif|jpe?g|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(value)
	);
}

function getIconImageUrl(iconName: string) {
	if (hasBindingExpression(iconName)) {
		return iconName;
	}

	const normalizedIconName = iconName.startsWith(iconReferencePrefix)
		? iconName.slice(iconReferencePrefix.length)
		: iconName;

	if (isSafeImageUrl(normalizedIconName)) {
		return normalizedIconName;
	}

	if (!/^[A-Za-z][A-Za-z0-9]*$/.test(normalizedIconName)) {
		return undefined;
	}

	return `${fluentIconCdnBaseUrl}${toSnakeCase(normalizedIconName)}_24_regular.svg`;
}

function resolveCardIcons(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(resolveCardIcons);
	}

	if (!isObject(value)) {
		return value;
	}

	const resolvedValue = Object.fromEntries(
		Object.entries(value).map(([key, childValue]) => [key, resolveCardIcons(childValue)]),
	);

	if (resolvedValue.type === "Icon" && typeof resolvedValue.name === "string") {
		const url = getIconImageUrl(resolvedValue.name);

		if (!url || hasBindingExpression(url)) {
			return resolvedValue;
		}

		const imageValue: Record<string, unknown> = {
			type: "Image",
			url,
			altText: resolvedValue.altText ?? resolvedValue.name,
			height: renderedIconSize,
			width: renderedIconSize,
		};

		for (const key of [
			"horizontalAlignment",
			"id",
			"isVisible",
			"selectAction",
			"separator",
			"spacing",
			"targetWidth",
		]) {
			if (key in resolvedValue) {
				imageValue[key] = resolvedValue[key];
			}
		}

		return imageValue;
	}

	if (typeof resolvedValue.iconUrl === "string") {
		const url = getIconImageUrl(resolvedValue.iconUrl);

		if (url && !hasBindingExpression(url)) {
			resolvedValue.iconUrl = url;
		}
	}

	return resolvedValue;
}

function getReferenceRoot(path: string) {
	return path.split(/[.[\]]/)[0];
}

function collectStringBindingRoots(value: string, roots: Set<string>) {
	for (const match of value.matchAll(rootReferencePattern)) {
		const rootName = match[1] ?? match[2];

		if (rootName) {
			roots.add(rootName);
		}
	}

	for (const match of value.matchAll(bindingPattern)) {
		roots.add(getReferenceRoot(match[1]));
	}
}

function collectBindingRoots(value: unknown, roots = new Set<string>()) {
	if (typeof value === "string") {
		collectStringBindingRoots(value, roots);

		return roots;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectBindingRoots(item, roots);
		}

		return roots;
	}

	if (isObject(value)) {
		for (const childValue of Object.values(value)) {
			collectBindingRoots(childValue, roots);
		}
	}

	return roots;
}

function getUnresolvedBindings(value: unknown, missing = new Set<string>()) {
	if (typeof value === "string") {
		for (const match of value.matchAll(bindingPattern)) {
			if (match[0] === value || value.includes(match[0])) {
				missing.add(match[1]);
			}
		}

		return missing;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			getUnresolvedBindings(item, missing);
		}

		return missing;
	}

	if (isObject(value)) {
		for (const childValue of Object.values(value)) {
			getUnresolvedBindings(childValue, missing);
		}
	}

	return missing;
}

function isSafeBindingName(value: string) {
	return /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function getR2BindingName(key: string) {
	return key.endsWith(".json") ? key.slice(0, -".json".length) : key;
}

async function getR2BindingValue(bucket: R2Bucket, bindingName: string) {
	const keys = bindingName.endsWith(".json") ? [bindingName] : [bindingName, `${bindingName}.json`];

	for (const key of keys) {
		const object = await bucket.get(key);
		if (!object || object.size > maxBindingBytes) {
			continue;
		}

		const text = await object.text();

		return parseMaybeJson(text);
	}

	return undefined;
}

function normalizeBindingValue(bindingName: string, value: unknown) {
	const normalizedName = getR2BindingName(bindingName);

	if (isObject(value) && normalizedName in value) {
		return value[normalizedName];
	}

	return value;
}

function isSafeReadQuery(query: string) {
	const normalizedQuery = query.trim().toLowerCase();

	return (
		(normalizedQuery.startsWith("select ") || normalizedQuery.startsWith("with ")) &&
		!normalizedQuery.includes(";") &&
		!normalizedQuery.includes("--") &&
		!normalizedQuery.includes("/*") &&
		!/\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum)\b/.test(
			normalizedQuery,
		)
	);
}

function shapeQueryResult(rows: Record<string, unknown>[]) {
	if (rows.length !== 1) {
		return rows;
	}

	const row = rows[0];
	const values = Object.values(row);

	return values.length === 1 ? parseMaybeJson(values[0]) : row;
}

async function getD1BindingValue(db: D1Database, query: string) {
	if (!isSafeReadQuery(query)) {
		return undefined;
	}

	try {
		const result = await db.prepare(query).all<Record<string, unknown>>();
		const rows = result.results ?? [];

		return shapeQueryResult(rows.slice(0, maxQueryRows));
	} catch {
		return undefined;
	}
}

function getBindingSpecs(dataColumn: unknown): BindingSpec[] {
	const parsedData = parseMaybeJson(dataColumn);

	if (typeof parsedData === "string") {
		return isSafeBindingName(parsedData)
			? [{ key: parsedData, name: getR2BindingName(parsedData), type: "r2" }]
			: [];
	}

	if (Array.isArray(parsedData)) {
		const specs: BindingSpec[] = [];

		for (const value of parsedData) {
			if (typeof value === "string" && isSafeBindingName(value)) {
				specs.push({ key: value, name: getR2BindingName(value), type: "r2" });
				continue;
			}

			if (!isObject(value)) {
				continue;
			}

			for (const [name, query] of Object.entries(value)) {
				if (typeof query === "string" && isSafeBindingName(name)) {
					specs.push({ name, query, type: "d1" });
				}
			}
		}

		return specs.slice(0, maxBindingsPerCard);
	}

	if (isObject(parsedData)) {
		const bindings = parsedData.bindings ?? parsedData.bindingNames ?? parsedData.data;
		if (Array.isArray(bindings)) {
			return getBindingSpecs(bindings);
		}

		return Object.entries(parsedData)
			.flatMap(([name, value]): BindingSpec[] => {
				if (!isSafeBindingName(name)) {
					return [];
				}

				if (typeof value === "string" && isSafeReadQuery(value)) {
					return [{ name, query: value, type: "d1" }];
				}

				return [{ key: name, name: getR2BindingName(name), type: "r2" }];
			})
			.slice(0, maxBindingsPerCard);
	}

	return [];
}

function getTemplateBindingSpecs(templatePayload: unknown, existingSpecs: BindingSpec[]) {
	const existingNames = new Set(existingSpecs.map((spec) => spec.name));

	return Array.from(collectBindingRoots(templatePayload))
		.filter((name) => isSafeBindingName(name) && !existingNames.has(name))
		.map((name): BindingSpec => ({ key: `${name}.json`, name, type: "r2" }))
		.slice(0, maxBindingsPerCard);
}

async function getBindingData(
	db: D1Database,
	bucket: R2Bucket | undefined,
	bindingSpecs: BindingSpec[],
) {
	const data: Record<string, unknown> = {};

	for (const spec of bindingSpecs.slice(0, maxBindingsPerCard)) {
		if (spec.type === "r2") {
			if (!bucket) {
				continue;
			}

			const value = await getR2BindingValue(bucket, spec.key);
			if (value === undefined) {
				continue;
			}

			const normalizedValue = normalizeBindingValue(spec.key, value);
			data[spec.name] = normalizedValue;

			if (isObject(normalizedValue)) {
				Object.assign(data, normalizedValue);
			}
		} else {
			const value = await getD1BindingValue(db, spec.query);
			if (value !== undefined) {
				data[spec.name] = value;
				continue;
			}

			if (!bucket) {
				continue;
			}

			const r2Value = await getR2BindingValue(bucket, spec.name);
			if (r2Value === undefined) {
				continue;
			}

			const normalizedValue = normalizeBindingValue(spec.name, r2Value);
			data[spec.name] = normalizedValue;

			if (isObject(normalizedValue)) {
				Object.assign(data, normalizedValue);
			}
		}
	}

	return data;
}

function prepareTemplatePayload(templatePayload: unknown, data: Record<string, unknown>) {
	const templateWithD1Cards = restoreD1CardTemplateReferences(templatePayload, data);

	return "icon" in data ? restoreIconTemplateReferences(templateWithD1Cards) : templateWithD1Cards;
}

function expandCardTemplate(templatePayload: unknown, data: Record<string, unknown>) {
	let expandedPayload = prepareTemplatePayload(templatePayload, data);

	for (let index = 0; index < maxTemplateExpansionPasses; index += 1) {
		const templatePayload =
			"icon" in data ? restoreIconTemplateReferences(expandedPayload) : expandedPayload;
		const template = new ACData.Template(templatePayload);
		const nextPayload = template.expand({
			$root: data,
		});

		if (JSON.stringify(nextPayload) === JSON.stringify(expandedPayload)) {
			return nextPayload;
		}

		expandedPayload = nextPayload;
	}

	return expandedPayload;
}

async function findCardRow(db: D1Database, cardName: string) {
	const spacedName = cardName.replace(/[-_]+/g, " ");

	return db
		.prepare(
			`
				SELECT payload, data
				FROM cards
				WHERE name IN (?, ?)
				LIMIT 1
			`,
		)
		.bind(cardName, spacedName)
		.first<CardRow>();
}

async function findSubmissionRow(db: D1Database, submissionId: string) {
	return db
		.prepare(
			`
				SELECT *
				FROM submissions
				WHERE "ID" = ?
				LIMIT 1
			`,
		)
		.bind(submissionId)
		.first<SubmissionRow>();
}

async function ensureSubmissionsTable(db: D1Database) {
	const table = await db
		.prepare(
			`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table' AND name = 'submissions'
				LIMIT 1
			`,
		)
		.first<{ name: string }>();

	if (!table) {
		await db
			.prepare(
				`
					CREATE TABLE submissions (
						ID TEXT PRIMARY KEY,
						payment TEXT NOT NULL
					)
				`,
			)
			.run();

		return;
	}

	const columns = await db.prepare(`PRAGMA table_info("submissions")`).all<{ name: string }>();
	const hasPaymentColumn = (columns.results ?? []).some(
		(column) => column.name.toLowerCase() === "payment",
	);

	if (!hasPaymentColumn) {
		await db.prepare(`ALTER TABLE submissions ADD COLUMN payment TEXT`).run();
	}
}

async function insertPaymentSubmission(db: D1Database, data: SubmittedCardData, payment: unknown) {
	await ensureSubmissionsTable(db);

	const id = createId();
	const columns = shapeSubmissionColumns(data);

	await db
		.prepare(
			`
				INSERT INTO submissions (
					"ID",
					"Member Number",
					"First Name",
					"Last Name",
					"Amount",
					"Message",
					"Email",
					"Payment"
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
		)
		.bind(
			id,
			columns.memberNumber ?? null,
			columns.firstName ?? null,
			columns.lastName ?? null,
			columns.amount ?? null,
			columns.message ?? null,
			columns.email ?? null,
			JSON.stringify(payment),
		)
		.run();

	return id;
}

function getCardNameFromRequest(c: AppContext) {
	return (
		c.req.param("cardName") ||
		c.req.query("card") ||
		c.req.query("q") ||
		c.req.query("name") ||
		""
	).trim();
}

async function getExpandedCard(
	db: D1Database,
	variablesBucket: R2Bucket | undefined,
	cardName: string,
	extraData: Record<string, unknown> = {},
) {
	const row = await findCardRow(db, cardName);

	if (!row) {
		return { error: "Card was not found", status: 404 } as const;
	}

	const templatePayload = parseMaybeJson(row.payload);

	if (!looksLikeCardPayload(templatePayload)) {
		return {
			error: "Stored card payload is not a valid Adaptive Card JSON payload",
			status: 422,
		} as const;
	}

	const bindingSpecs = getBindingSpecs(row.data);
	const templateBindingSpecs = getTemplateBindingSpecs(templatePayload, bindingSpecs);
	const data = await getBindingData(db, variablesBucket, bindingSpecs);
	const templateData = await getBindingData(db, variablesBucket, templateBindingSpecs);
	Object.assign(data, templateData, extraData);

	let card: unknown;

	try {
		card = resolveCardIcons(expandCardTemplate(templatePayload, data));
	} catch (error) {
		return {
			error:
				error instanceof Error
					? `Adaptive Card template expansion failed: ${error.message}`
					: "Adaptive Card template expansion failed",
			status: 422,
		} as const;
	}

	const unresolvedBindings = Array.from(getUnresolvedBindings(card)).filter(
		(binding) => binding !== "fallback",
	);

	if (unresolvedBindings.length > 0) {
		return {
			error: `Missing data bindings: ${unresolvedBindings.join(", ")}`,
			status: 422,
		} as const;
	}

	if (!looksLikeCardPayload(card)) {
		return {
			error: "Expanded card payload is not a valid Adaptive Card JSON payload",
			status: 422,
		} as const;
	}

	return { card, status: 200 } as const;
}

async function getCard(c: AppContext) {
	const cardName = getCardNameFromRequest(c);
	const db = c.env.adaptive_cards;
	const variablesBucket = c.env.adaptive_card_variables;

	if (!cardName) {
		return c.json({ error: "Missing card search term" }, 400);
	}

	if (cardName.length > 128) {
		return c.json({ error: "Card search term is too long" }, 400);
	}

	if (!db) {
		return c.json({ error: "Card database is not configured" }, 500);
	}

	try {
		const result = await getExpandedCard(db, variablesBucket, cardName);

		if ("card" in result) {
			return c.json({ card: result.card });
		}

		return c.json({ error: result.error }, result.status);
	} catch {
		return c.json(
			{
				error: "Failed to load card. Verify the local D1 database has a cards table with payload and data columns.",
			},
			500,
		);
	}
}

async function submitCard(c: AppContext) {
	const cardName = getCardNameFromRequest(c);
	const db = c.env.adaptive_cards;
	const contentLength = Number(c.req.header("content-length") ?? 0);

	if (!cardName) {
		return c.json({ error: "Missing card search term" }, 400);
	}

	if (cardName !== "payment-tracking") {
		return c.json({ error: "Submissions are only configured for payment-tracking" }, 400);
	}

	if (!db) {
		return c.json({ error: "Card database is not configured" }, 500);
	}

	if (contentLength > maxSubmissionBytes) {
		return c.json({ error: "Submission payload is too large" }, 413);
	}

	let body: unknown;

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Submission must be valid JSON" }, 400);
	}

	if (!isObject(body) || !isObject(body.data)) {
		return c.json({ error: "Submission data is missing" }, 400);
	}

	const payment = shapePaymentSubmission(body.data);

	if (!hasPaymentSubmissionData(payment)) {
		return c.json({ error: "Submission does not contain payment data" }, 400);
	}

	try {
		const id = await insertPaymentSubmission(db, body.data, payment);

		return c.json({ id, ok: true }, 201);
	} catch {
		return c.json({ error: "Failed to store submission" }, 500);
	}
}

async function lookupPaymentDetailsCard(c: AppContext) {
	const submissionId = (c.req.param("submissionId") || "").trim();
	const db = c.env.adaptive_cards;
	const variablesBucket = c.env.adaptive_card_variables;

	if (!submissionId) {
		return c.json({ error: "Missing submission ID" }, 400);
	}

	if (submissionId.length > 128) {
		return c.json({ error: "Submission ID is too long" }, 400);
	}

	if (!db) {
		return c.json({ error: "Card database is not configured" }, 500);
	}

	try {
		const row = await findSubmissionRow(db, submissionId);

		if (!row) {
			return c.json({ error: "Submission was not found" }, 404);
		}

		const result = await getExpandedCard(
			db,
			variablesBucket,
			paymentDetailsCardName,
			shapeSubmissionLookupData(row),
		);

		if ("card" in result) {
			return c.json({ card: result.card });
		}

		return c.json({ error: result.error }, result.status);
	} catch {
		return c.json({ error: "Failed to load payment details card" }, 500);
	}
}

function serveClientApp(c: AppContext) {
	const submissionId = (c.req.param("submissionId") || "").trim();
	const url = new URL(c.req.url);
	url.pathname = "/";
	url.search = submissionId ? `?lookup=${encodeURIComponent(submissionId)}` : "";

	return c.redirect(url.toString(), 302);
}

app.get("/api", getCard);
app.get("/api/lookup/:submissionId", lookupPaymentDetailsCard);
app.get("/api/:cardName", getCard);
app.post("/api/:cardName/submissions", submitCard);
app.get("/lookup/:submissionId", serveClientApp);

export default app;
