import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { DatabaseSync } from "node:sqlite";
import multer from "multer";
import crypto from "crypto";
import { Agent } from "undici";

const app = express();
const PORT = 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
	process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
const LOCALE = process.env.LOCALE || "english";
const COQUI_BASE_URL =
	process.env.COQUI_BASE_URL || "http://coqui:5002/api/tts";
const COQUI_SERVER_URL = process.env.COQUI_SERVER_URL || "http://coqui:5002";
const TTS_UPSTREAM_TIMEOUT_MS =
	Number.parseInt(process.env.TTS_UPSTREAM_TIMEOUT_MS || "86400000", 10) ||
	86400000;
const TTS_HTTP_TIMEOUT_MS = Math.max(60_000, TTS_UPSTREAM_TIMEOUT_MS + 5_000);
const TTS_FETCH_DISPATCHER = new Agent({
	headersTimeout: TTS_HTTP_TIMEOUT_MS,
	bodyTimeout: TTS_HTTP_TIMEOUT_MS,
});
const DEFAULT_VIDEO_ORIENTATION = String(
	process.env.DEFAULT_VIDEO_ORIENTATION || "portrait",
).toLowerCase();
const DEFAULT_VIDEO_WIDTH = Number.parseInt(
	process.env.DEFAULT_VIDEO_WIDTH || "0",
	10,
);
const DEFAULT_VIDEO_HEIGHT = Number.parseInt(
	process.env.DEFAULT_VIDEO_HEIGHT || "0",
	10,
);
const APP_DB_PATH = process.env.APP_DB_PATH || "/app/data/settings.db";
const DEFAULT_INPUT_VIDEOS_DIR = process.env.INPUT_VIDEOS_DIR || "/mnt/videos";
const DEFAULT_OUTPUT_VIDEOS_DIR =
	process.env.OUTPUT_VIDEOS_DIR || "/mnt/videos/generated";

const db = initSettingsDatabase(APP_DB_PATH);
const SETTINGS_SCHEMA = {
	input_videos_dir: "string",
	output_videos_dir: "string",
	default_video_orientation: "string",
	default_video_width: "int",
	default_video_height: "int",
	coqui_speaker_id: "string",
	coqui_language_id: "string",
	locale: "string",
	subtitles_enabled_by_default: "bool",
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm"]);

const ORIENTATION_PRESETS = {
	portrait: { width: 1080, height: 1920 },
	landscape: { width: 1920, height: 1080 },
	square: { width: 1080, height: 1080 },
};

const LOCALE_LANGUAGE_MAP = {
	english: "en",
	espanol: "es",
	spanish: "es",
	french: "fr",
	german: "de",
	italian: "it",
	portuguese: "pt",
	polish: "pl",
	turkish: "tr",
	russian: "ru",
	dutch: "nl",
	czech: "cs",
	arabic: "ar",
	chinese: "zh-cn",
	japanese: "ja",
	hungarian: "hu",
	korean: "ko",
	hindi: "hi",
};

const XTTS_FALLBACK_LANGUAGES = [
	"en",
	"es",
	"fr",
	"de",
	"it",
	"pt",
	"pl",
	"tr",
	"ru",
	"nl",
	"cs",
	"ar",
	"zh-cn",
	"hu",
	"ko",
	"ja",
	"hi",
];

const XTTS_FALLBACK_SPEAKERS = [
	"Claribel Dervla",
	"Daisy Studious",
	"Gracie Wise",
	"Tammie Ema",
	"Alison Dietlinde",
	"Ana Florence",
	"Annmarie Nele",
	"Asya Anara",
	"Brenda Stern",
	"Gitta Nikolina",
	"Henriette Usha",
	"Sofia Hellen",
	"Tammy Grit",
	"Tanja Adelina",
	"Vjollca Johnnie",
	"Andrew Chipper",
	"Badr Odhiambo",
	"Dionisio Schuyler",
	"Royston Min",
	"Viktor Eka",
	"Abrahan Mack",
	"Adde Michal",
	"Baldur Sanjin",
	"Craig Gutsy",
	"Damien Black",
	"Gilberto Mathias",
	"Ilkin Urbano",
	"Kazuhiko Atallah",
	"Ludvig Milivoj",
	"Suad Qasim",
	"Torcull Diarmuid",
	"Viktor Menelaos",
	"Zacharie Aimilios",
	"Nova Hogarth",
	"Maja Ruoho",
	"Uta Obando",
	"Lidiya Szekeres",
	"Chandra MacFarland",
	"Szofi Granger",
	"Camilla Holmstrom",
	"Lilya Stainthorpe",
	"Zofija Kendrick",
	"Narelle Moon",
	"Barbora MacLean",
	"Alexandra Hisakawa",
	"Alma Maria",
	"Rosemary Okafor",
	"Ige Behringer",
	"Filip Traverse",
	"Damjan Chapman",
	"Wulf Carlevaro",
	"Aaron Dreschner",
	"Kumar Dahl",
	"Eugenio Mataraci",
	"Ferran Simen",
	"Xavier Hayasaka",
	"Luis Moray",
	"Marcos Rudaski",
];

let prompt = `You are a professional short-form content strategist and scriptwriter.

You will receive a USER_PROMPT describing what kind of video to create.

Create exactly one JSON object with these fields:
- "title": catchy title under 100 characters. Hashtags are allowed.
- "description": short engaging description with relevant hashtags.
- "body": voiceover script for a faceless short video (250-300 words), fast paced, natural narration, no placeholders.

Rules:
- Make the script strong for retention: hook early, keep momentum, finish with a call to action.
- Do not use first-person visual framing like "I am on screen".
- Do not include hashtags in "body"; hashtags belong only in title/description.
- Return only valid JSON. No markdown fences. No extra text.`;

let runtimeSettings = loadRuntimeSettings();

app.use(express.json({ limit: "10mb" })); // JSON + base64 handling

function initSettingsDatabase(dbPath) {
	const dbDir = path.dirname(dbPath);
	if (!fs.existsSync(dbDir)) {
		fs.mkdirSync(dbDir, { recursive: true });
	}

	const database = new DatabaseSync(dbPath);
	database.exec(`
		CREATE TABLE IF NOT EXISTS app_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		
		CREATE TABLE IF NOT EXISTS upload_jobs (
			id TEXT PRIMARY KEY,
			filename TEXT NOT NULL,
			size INTEGER NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed', 'corrupted')),
			error_message TEXT,
			checksum TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			completed_at TEXT
		);
		
		CREATE INDEX IF NOT EXISTS idx_upload_jobs_status ON upload_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_upload_jobs_created_at ON upload_jobs(created_at);
	`);

	return database;
}

function getSetting(key, fallbackValue) {
	const row = db
		.prepare("SELECT value FROM app_settings WHERE key = ?")
		.get(key);
	if (!row || typeof row.value !== "string") {
		return fallbackValue;
	}
	return row.value;
}

function setSetting(key, value) {
	const statement = db.prepare(`
		INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = CURRENT_TIMESTAMP
	`);
	statement.run(key, String(value));
}

function parseBoolean(value, fallback = false) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function loadRuntimeSettings() {
	const defaultOrientation = normalizeOrientation(
		getSetting("default_video_orientation", DEFAULT_VIDEO_ORIENTATION),
	);
	const defaultWidth = parsePositiveInt(
		getSetting("default_video_width", String(DEFAULT_VIDEO_WIDTH || 0)),
	);
	const defaultHeight = parsePositiveInt(
		getSetting("default_video_height", String(DEFAULT_VIDEO_HEIGHT || 0)),
	);

	return {
		inputVideosDir: getSetting("input_videos_dir", DEFAULT_INPUT_VIDEOS_DIR),
		outputVideosDir: getSetting("output_videos_dir", DEFAULT_OUTPUT_VIDEOS_DIR),
		defaultVideoOrientation: defaultOrientation,
		defaultVideoWidth: defaultWidth || null,
		defaultVideoHeight: defaultHeight || null,
		coquiSpeakerId: getSetting(
			"coqui_speaker_id",
			process.env.COQUI_SPEAKER_ID || "",
		),
		coquiLanguageId: getSetting(
			"coqui_language_id",
			process.env.COQUI_LANGUAGE_ID || "",
		),
		locale: getSetting("locale", LOCALE),
		subtitlesEnabledByDefault: parseBoolean(
			getSetting("subtitles_enabled_by_default", "true"),
			true,
		),
	};
}

function serializeRuntimeSettings(settings) {
	return {
		input_videos_dir: settings.inputVideosDir,
		output_videos_dir: settings.outputVideosDir,
		default_video_orientation: settings.defaultVideoOrientation,
		default_video_width: settings.defaultVideoWidth,
		default_video_height: settings.defaultVideoHeight,
		coqui_speaker_id: settings.coquiSpeakerId || null,
		coqui_language_id: settings.coquiLanguageId || null,
		locale: settings.locale,
		subtitles_enabled_by_default: settings.subtitlesEnabledByDefault,
	};
}

function validateAndNormalizeSettingValue(key, value) {
	if (!(key in SETTINGS_SCHEMA)) {
		throw new Error(`Unsupported setting: ${key}`);
	}

	const expectedType = SETTINGS_SCHEMA[key];
	if (expectedType === "string") {
		if (value === null || value === undefined) {
			return "";
		}
		if (typeof value !== "string") {
			throw new Error(`Setting '${key}' must be a string`);
		}
		const trimmed = value.trim();
		if (
			(key === "input_videos_dir" || key === "output_videos_dir") &&
			!trimmed
		) {
			throw new Error(`Setting '${key}' cannot be empty`);
		}
		return trimmed;
	}

	if (expectedType === "int") {
		const parsed = parsePositiveInt(value);
		if (!parsed) {
			throw new Error(`Setting '${key}' must be a positive integer`);
		}
		return String(parsed);
	}

	if (expectedType === "bool") {
		if (typeof value !== "boolean") {
			throw new Error(`Setting '${key}' must be a boolean`);
		}
		return value ? "true" : "false";
	}

	throw new Error(`Unsupported schema type for '${key}'`);
}

function ensureDirectoryExists(folderPath) {
	if (!fs.existsSync(folderPath)) {
		fs.mkdirSync(folderPath, { recursive: true });
	}
}

function sanitizeUploadedFileName(originalName) {
	const parsed = path.parse(originalName || "video");
	const safeBase = (parsed.name || "video")
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.slice(0, 80);
	const ext = String(parsed.ext || "").toLowerCase();
	return `${safeBase || "video"}_${Date.now()}_${uuidv4().slice(0, 8)}${ext}`;
}

function calculateFileChecksum(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath);
		stream.on("error", reject);
		stream.on("data", (data) => hash.update(data));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function verifyUploadedFile(filePath, expectedSize) {
	const stats = fs.statSync(filePath);
	if (stats.size !== expectedSize) {
		throw new Error(
			`File size mismatch: expected ${expectedSize}, got ${stats.size}`,
		);
	}

	const checksum = await calculateFileChecksum(filePath);
	return checksum;
}

const uploadStorage = multer.diskStorage({
	destination: (_req, _file, cb) => {
		try {
			ensureDirectoryExists(runtimeSettings.inputVideosDir);
			cb(null, runtimeSettings.inputVideosDir);
		} catch (err) {
			cb(err);
		}
	},
	filename: (_req, file, cb) => {
		cb(null, sanitizeUploadedFileName(file.originalname));
	},
});

const uploadVideosMiddleware = multer({
	storage: uploadStorage,
	limits: { fileSize: 1024 * 1024 * 1024, files: 10 },
	fileFilter: (_req, file, cb) => {
		const ext = path.extname(file.originalname || "").toLowerCase();
		if (VIDEO_EXTENSIONS.has(ext)) {
			cb(null, true);
			return;
		}
		cb(new Error("Only video files (.mp4, .mov, .mkv, .webm) are allowed"));
	},
});

async function proxyTTSRequest(req, res) {
	const text = req.body?.text ?? req.query?.text;
	let speakerId =
		req.body?.speaker_id ??
		req.query?.speaker_id ??
		runtimeSettings.coquiSpeakerId ??
		process.env.COQUI_SPEAKER_ID;
	const languageId =
		req.body?.language_id ??
		req.query?.language_id ??
		runtimeSettings.coquiLanguageId ??
		process.env.COQUI_LANGUAGE_ID ??
		LOCALE_LANGUAGE_MAP[String(runtimeSettings.locale || "").toLowerCase()] ??
		"en";

	if (!text || typeof text !== "string") {
		return res
			.status(400)
			.json({ error: "Missing required string field: text" });
	}

	try {
		if (!speakerId) {
			const speakers = await getCoquiSpeakers();
			speakerId = speakers[0];
		}

		const params = new URLSearchParams();
		params.set("text", text);
		if (speakerId) {
			params.set("speaker_id", String(speakerId));
		}
		if (languageId) {
			params.set("language_id", String(languageId));
		}

		const url = `${COQUI_BASE_URL}?${params.toString()}`;
		const response = await fetch(url, {
			signal: AbortSignal.timeout(TTS_UPSTREAM_TIMEOUT_MS),
			dispatcher: TTS_FETCH_DISPATCHER,
		});
		if (!response.ok) {
			const errorText = await response.text();
			return res.status(response.status).json({
				error: "Coqui TTS request failed",
				details: errorText || `Coqui returned HTTP ${response.status}`,
			});
		}

		const contentType = response.headers.get("content-type") || "audio/wav";
		const audioBuffer = Buffer.from(await response.arrayBuffer());
		res.setHeader("Content-Type", contentType);
		return res.send(audioBuffer);
	} catch (err) {
		console.error("TTS proxy request failed:", err);
		return res
			.status(500)
			.json({ error: "Unexpected error in /tts", details: String(err) });
	}
}

function extractSelectOptions(html, selectId) {
	const selectRegex = new RegExp(
		`<select[^>]*id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`,
		"i",
	);
	const match = html.match(selectRegex);
	if (!match) return [];

	const optionRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>/gi;
	const options = [];
	let optionMatch;

	while ((optionMatch = optionRegex.exec(match[1])) !== null) {
		const value = String(optionMatch[1] || "").trim();
		if (!value) continue;
		if (!options.includes(value)) options.push(value);
	}

	return options;
}

async function getCoquiSpeakers() {
	try {
		const response = await fetch(`${COQUI_SERVER_URL}/`);
		if (!response.ok) {
			throw new Error(`Coqui homepage returned HTTP ${response.status}`);
		}

		const html = await response.text();
		const parsed = extractSelectOptions(html, "speaker_id");
		return parsed.length > 0 ? parsed : XTTS_FALLBACK_SPEAKERS;
	} catch (_err) {
		return XTTS_FALLBACK_SPEAKERS;
	}
}

async function getCoquiLanguages() {
	try {
		const response = await fetch(`${COQUI_SERVER_URL}/`);
		if (!response.ok) {
			throw new Error(`Coqui homepage returned HTTP ${response.status}`);
		}

		const html = await response.text();
		const parsed = extractSelectOptions(html, "language_id");
		return parsed.length > 0 ? parsed : XTTS_FALLBACK_LANGUAGES;
	} catch (_err) {
		return XTTS_FALLBACK_LANGUAGES;
	}
}

function extractJsonCandidate(text) {
	return text
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/```$/i, "")
		.trim();
}

async function callGemini(parts) {
	if (!GEMINI_API_KEY) {
		throw new Error("GEMINI_API_KEY is not configured");
	}

	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts }] }),
		},
	);

	const geminiRes = await response.json();
	if (!response.ok) {
		const message = geminiRes?.error?.message || "Gemini API request failed";
		throw new Error(message);
	}

	const data = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!data) {
		throw new Error("Gemini response did not include generated content");
	}

	return data;
}

async function callOpenRouter(parts) {
	if (!OPENROUTER_API_KEY) {
		throw new Error("OPENROUTER_API_KEY is not configured");
	}

	const messages = parts.map((p, index) => ({
		role: index === 0 ? "system" : "user",
		content: p.text,
	}));

	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENROUTER_MODEL,
				messages,
			}),
		},
	);

	const openRouterRes = await response.json();
	if (!response.ok) {
		const message =
			openRouterRes?.error?.message || "OpenRouter API request failed";
		throw new Error(message);
	}

	const data = openRouterRes?.choices?.[0]?.message?.content;
	if (!data) {
		throw new Error("OpenRouter response did not include generated content");
	}

	return data;
}

async function generateTextWithFallback(parts) {
	try {
		return await callGemini(parts);
	} catch (geminiErr) {
		console.warn(
			"Gemini request failed. Falling back to OpenRouter:",
			String(geminiErr),
		);
		return callOpenRouter(parts);
	}
}

// ---------------- /generate ----------------
app.post("/generate", async (req, res) => {
	try {
		const userPrompt = req.body?.prompt;
		if (!userPrompt || typeof userPrompt !== "string") {
			return res
				.status(400)
				.json({ error: "Missing required string field: prompt" });
		}

		const data = await generateTextWithFallback([
			{ text: prompt },
			{ text: `USER_PROMPT:\n${userPrompt}` },
		]);

		const cleaned = extractJsonCandidate(data);

		const json = cleaned.substring(
			cleaned.indexOf("{"),
			cleaned.lastIndexOf("}") + 1,
		);
		try {
			return res.json(JSON.parse(json));
		} catch (err) {
			console.error("Error parsing JSON:", err);
			return res
				.status(500)
				.json({ error: "Failed to parse JSON response", response: data });
		}
	} catch (err) {
		console.error("/generate failed (Gemini + OpenRouter fallback):", err);
		return res
			.status(500)
			.json({ error: "Unexpected error in /generate", details: String(err) });
	}
});

app.get("/tts", proxyTTSRequest);
app.post("/tts", proxyTTSRequest);

app.get("/speakers", async (req, res) => {
	try {
		const speakers = await getCoquiSpeakers();
		return res.json({ speakers });
	} catch (err) {
		console.error("Failed to fetch Coqui speakers:", err);
		return res
			.status(500)
			.json({ error: "Failed to fetch speakers", details: String(err) });
	}
});

app.get("/languages", async (req, res) => {
	try {
		const languages = await getCoquiLanguages();
		return res.json({ languages });
	} catch (err) {
		console.error("Failed to fetch Coqui languages:", err);
		return res
			.status(500)
			.json({ error: "Failed to fetch languages", details: String(err) });
	}
});

app.get("/settings", (_req, res) => {
	res.json(serializeRuntimeSettings(runtimeSettings));
});

app.post("/videos/upload", (req, res) => {
	uploadVideosMiddleware.array("videos", 10)(req, res, async (err) => {
		if (err) {
			const message =
				typeof err?.message === "string" ? err.message : "Video upload failed";
			return res.status(400).json({ error: message });
		}

		const uploadedFiles = Array.isArray(req.files) ? req.files : [];
		if (uploadedFiles.length === 0) {
			return res.status(400).json({ error: "No video files uploaded" });
		}

		const jobs = [];
		for (const file of uploadedFiles) {
			const jobId = uuidv4();
			try {
				const filePath = path.join(
					runtimeSettings.inputVideosDir,
					file.filename,
				);
				const checksum = await verifyUploadedFile(filePath, file.size);

				const stmt = db.prepare(`
					INSERT INTO upload_jobs (id, filename, size, status, checksum, created_at)
					VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
				`);
				stmt.run(jobId, file.filename, file.size, "completed", checksum);

				jobs.push({
					id: jobId,
					filename: file.filename,
					size: file.size,
					checksum,
					status: "completed",
				});
			} catch (verifyErr) {
				const stmt = db.prepare(`
					INSERT INTO upload_jobs (id, filename, size, status, error_message)
					VALUES (?, ?, ?, ?, ?)
				`);
				stmt.run(
					jobId,
					file.filename,
					file.size,
					"corrupted",
					String(verifyErr),
				);

				console.error(
					`Upload verification failed for ${file.filename}:`,
					verifyErr,
				);
				jobs.push({
					id: jobId,
					filename: file.filename,
					size: file.size,
					status: "corrupted",
					error: String(verifyErr),
				});
			}
		}

		return res.json({
			success: true,
			upload_dir: runtimeSettings.inputVideosDir,
			jobs,
		});
	});
});

app.put("/settings", (req, res) => {
	const payload = req.body;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return res
			.status(400)
			.json({ error: "Request body must be a JSON object" });
	}

	try {
		for (const [key, value] of Object.entries(payload)) {
			const normalized = validateAndNormalizeSettingValue(key, value);
			if (key === "default_video_orientation") {
				const orientation = normalizeOrientation(normalized);
				if (orientation !== normalized) {
					throw new Error(
						"Setting 'default_video_orientation' must be one of portrait, landscape, square, custom, original",
					);
				}
			}

			setSetting(key, normalized);
		}

		runtimeSettings = loadRuntimeSettings();
		return res.json({
			success: true,
			settings: serializeRuntimeSettings(runtimeSettings),
		});
	} catch (err) {
		return res.status(400).json({ error: String(err?.message || err) });
	}
});

// ---------------- /burn ----------------
app.post("/burn", async (req, res) => {
	let {
		video,
		audio,
		subtitles,
		fontsize = 30,
		outline = 2,
		orientation,
		width,
		height,
	} = req.body;
	if (!audio) return res.status(400).send("Missing parameters");

	orientation = normalizeOrientation(
		orientation || runtimeSettings.defaultVideoOrientation,
	);
	if (orientation === "custom") {
		width = parsePositiveInt(width) || runtimeSettings.defaultVideoWidth;
		height = parsePositiveInt(height) || runtimeSettings.defaultVideoHeight;
	}

	try {
		resolveVideoGeometry(orientation, width, height);
	} catch (err) {
		return res.status(400).json({ error: String(err) });
	}

	console.log(
		`/burn orientation=${orientation}${orientation === "custom" ? ` ${width}x${height}` : ""}`,
	);

	const tmp = `/tmp/${uuidv4()}`;
	fs.mkdirSync(tmp);

	try {
		const audioPath = `${tmp}/audio.wav`;
		const hasSubtitles =
			typeof subtitles === "string" && subtitles.trim().length > 0;
		const subPath = `${tmp}/sub.srt`;
		const assPath = `${tmp}/sub.ass`;
		const outputPath = `${tmp}/output.mp4`;

		fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
		if (hasSubtitles) {
			fs.writeFileSync(subPath, subtitles);
		}

		let videoFilePath;
		let startOffset = 0;

		// If video is not provided, select a random default_ video
		if (!video) {
			const allFiles = fs.readdirSync(runtimeSettings.inputVideosDir);
			const videoFiles = allFiles.filter((f) =>
				/\.(mp4|mov|mkv|webm)$/i.test(f),
			);
			const defaultVideos = videoFiles.filter((f) => f.startsWith("default_"));
			const candidates = defaultVideos.length > 0 ? defaultVideos : videoFiles;
			if (candidates.length === 0)
				throw new Error(
					`No video files found in ${runtimeSettings.inputVideosDir}`,
				);
			video = candidates[Math.floor(Math.random() * candidates.length)];
			videoFilePath = path.join(runtimeSettings.inputVideosDir, video);

			const videoDuration = await getDuration(videoFilePath);
			const audioDuration = await getDuration(audioPath);
			const delta = Math.max(videoDuration - audioDuration - 1, 0);
			startOffset = delta > 0 ? Math.random() * delta : 0;
		} else {
			videoFilePath = path.join(runtimeSettings.inputVideosDir, video);
			if (!fs.existsSync(videoFilePath))
				return res.status(404).send("Video file not found");
		}

		if (hasSubtitles) {
			// Generate styled ASS subtitles
			await execPromise(`ffmpeg -y -i "${subPath}" "${assPath}"`);
			await execPromise(
				`sed -i '/^Style:/c\\Style: Default,Montserrat ExtraBold,${fontsize},&H00FFFFFF,&H00000000,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,${outline},2,10,10,10,1' "${assPath}"`,
			);
			await execPromise(
				`grep -q "WrapStyle" "${assPath}" && sed -i 's/WrapStyle.*/WrapStyle: 0/' "${assPath}" || sed -i '/^\\[Script Info\\]/a WrapStyle: 0' "${assPath}"`,
			);
		}

		const videoFilter = buildVideoFilter(
			hasSubtitles ? assPath : null,
			orientation,
			width,
			height,
		);

		// Burn subtitles, combine video + audio
		await execPromise(
			`ffmpeg -y -ss ${startOffset.toFixed(2)} -i "${videoFilePath}" -i "${audioPath}" ${videoFilter ? `-vf "${videoFilter}"` : ""} -map 0:v:0 -map 1:a:0 -c:v libx264 -c:a aac -shortest "${outputPath}"`,
		);

		if (!fs.existsSync(runtimeSettings.outputVideosDir)) {
			fs.mkdirSync(runtimeSettings.outputVideosDir, { recursive: true });
		}
		const savedFileName = `generated_${Date.now()}_${uuidv4().slice(0, 8)}.mp4`;
		const savedOutputPath = path.join(
			runtimeSettings.outputVideosDir,
			savedFileName,
		);
		fs.copyFileSync(outputPath, savedOutputPath);
		console.log(`Saved rendered video to ${savedOutputPath}`);

		res.setHeader("Content-Type", "video/mp4");
		const readStream = fs.createReadStream(outputPath);
		readStream.pipe(res);
		readStream.on("close", () => cleanup(tmp));
	} catch (err) {
		console.error(err);
		cleanup(tmp);
		res.status(500).send("Internal server error");
	}
});

app.get("/coquiSpeakerId", (req, res) => {
	const speakerId =
		runtimeSettings.coquiSpeakerId || process.env.COQUI_SPEAKER_ID;
	const languageId =
		runtimeSettings.coquiLanguageId ||
		process.env.COQUI_LANGUAGE_ID ||
		LOCALE_LANGUAGE_MAP[String(runtimeSettings.locale || "").toLowerCase()] ||
		"en";
	res.json({ speakerId: speakerId || null, languageId });
});

app.get("/video-config", (_req, res) => {
	res.json({
		defaultOrientation: runtimeSettings.defaultVideoOrientation,
		defaultWidth: runtimeSettings.defaultVideoWidth,
		defaultHeight: runtimeSettings.defaultVideoHeight,
		subtitlesEnabledByDefault: runtimeSettings.subtitlesEnabledByDefault,
	});
});

// ----------- Video/Upload Management Endpoints -----------

// List all uploaded videos in the input directory
app.get("/videos/list", (_req, res) => {
	try {
		ensureDirectoryExists(runtimeSettings.inputVideosDir);
		const files = fs.readdirSync(runtimeSettings.inputVideosDir);
		const videos = files
			.filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f))
			.map((filename) => {
				const filePath = path.join(runtimeSettings.inputVideosDir, filename);
				const stats = fs.statSync(filePath);
				return {
					filename,
					size: stats.size,
					createdAt: stats.birthtime.toISOString(),
					modifiedAt: stats.mtime.toISOString(),
				};
			})
			.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

		return res.json({
			videos,
			totalCount: videos.length,
			uploadDir: runtimeSettings.inputVideosDir,
		});
	} catch (err) {
		console.error("Failed to list videos:", err);
		return res.status(500).json({ error: String(err) });
	}
});

// Get upload job status
app.get("/jobs/uploads/:jobId", (req, res) => {
	try {
		const { jobId } = req.params;
		const stmt = db.prepare("SELECT * FROM upload_jobs WHERE id = ?");
		const job = stmt.get(jobId);

		if (!job) {
			return res.status(404).json({ error: "Job not found" });
		}

		return res.json({
			id: job.id,
			filename: job.filename,
			size: job.size,
			status: job.status,
			checksum: job.checksum,
			errorMessage: job.error_message,
			createdAt: job.created_at,
			completedAt: job.completed_at,
		});
	} catch (err) {
		console.error("Failed to get job status:", err);
		return res.status(500).json({ error: String(err) });
	}
});

// List recent upload jobs
app.get("/jobs/uploads", (req, res) => {
	try {
		const limit = Math.min(Number.parseInt(req.query.limit || "50", 10), 200);
		const status = req.query.status; // Filter by status if provided

		let sql = "SELECT * FROM upload_jobs ORDER BY created_at DESC LIMIT ?";
		const params = [limit];

		if (status) {
			sql =
				"SELECT * FROM upload_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?";
			params.unshift(status);
		}

		const stmt = db.prepare(sql);
		const jobs = stmt.all(...params);

		return res.json({
			jobs: jobs.map((job) => ({
				id: job.id,
				filename: job.filename,
				size: job.size,
				status: job.status,
				errorMessage: job.error_message,
				createdAt: job.created_at,
				completedAt: job.completed_at,
			})),
			count: jobs.length,
		});
	} catch (err) {
		console.error("Failed to list jobs:", err);
		return res.status(500).json({ error: String(err) });
	}
});

// Delete uploaded video and its job record
app.delete("/videos/:filename", (req, res) => {
	try {
		const { filename } = req.params;

		// Sanitize filename to prevent directory traversal
		if (filename.includes("..") || filename.includes("/")) {
			return res.status(400).json({ error: "Invalid filename" });
		}

		const filePath = path.join(runtimeSettings.inputVideosDir, filename);
		const realPath = fs.realpathSync(runtimeSettings.inputVideosDir);

		// Ensure the file is within the input directory
		if (!fs.realpathSync(filePath).startsWith(realPath)) {
			return res.status(400).json({ error: "Invalid filename" });
		}

		if (!fs.existsSync(filePath)) {
			return res.status(404).json({ error: "Video file not found" });
		}

		// Delete the file
		fs.unlinkSync(filePath);

		// Delete the job record
		const stmt = db.prepare("DELETE FROM upload_jobs WHERE filename = ?");
		stmt.run(filename);

		return res.json({
			success: true,
			message: `Deleted ${filename}`,
		});
	} catch (err) {
		console.error("Failed to delete video:", err);
		return res.status(500).json({ error: String(err) });
	}
});

function execPromise(cmd) {
	return new Promise((resolve, reject) => {
		exec(cmd, (error, stdout, stderr) =>
			error ? reject(stderr) : resolve(stdout),
		);
	});
}

async function getDuration(filePath) {
	const stdout = await execPromise(
		`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
	);
	return parseFloat(stdout.trim());
}

function cleanup(folder) {
	fs.rmSync(folder, { recursive: true, force: true });
}

function normalizeOrientation(value) {
	const orientation = String(value || "").toLowerCase();
	if (
		["portrait", "landscape", "square", "custom", "original"].includes(
			orientation,
		)
	) {
		return orientation;
	}
	return "portrait";
}

function parsePositiveInt(value) {
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

function resolveVideoGeometry(orientation, width, height) {
	if (orientation === "original") {
		return null;
	}

	if (orientation === "custom") {
		const customWidth = parsePositiveInt(width);
		const customHeight = parsePositiveInt(height);
		if (!customWidth || !customHeight) {
			throw new Error(
				"Custom orientation requires valid positive width and height",
			);
		}
		return { width: customWidth, height: customHeight };
	}

	return ORIENTATION_PRESETS[orientation] || ORIENTATION_PRESETS.portrait;
}

function buildVideoFilter(assPath, orientation, width, height) {
	const geometry = resolveVideoGeometry(orientation, width, height);
	const subtitlesFilter = assPath
		? `subtitles=${assPath}:fontsdir=/app/fonts`
		: "";

	if (!geometry) {
		return subtitlesFilter;
	}

	const { width: targetWidth, height: targetHeight } = geometry;
	const scaleCropFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;
	return subtitlesFilter
		? `${scaleCropFilter},${subtitlesFilter}`
		: scaleCropFilter;
}

(async () => {
	// first thing we do is check if locale is different from english, if so we ask gemini to translate the prompt to the locale language
	if (runtimeSettings.locale !== "english") {
		try {
			prompt = await generateTextWithFallback([
				{
					text: `System: You are a professional translator. Please translate the following prompt from english to ${runtimeSettings.locale}. Ensure the translation is accurate and meaning is preserved. JSON contents MUST be translated in ${runtimeSettings.locale} too, that's mandatory. Omit the system prompt from the translation and translate only user content, ensure full prompt is translated (do not miss any part, and DO NOT add any additional part not in the prompt).\n\n User:`,
				},
				{ text: prompt },
			]);
			console.log(`Prompt translated to ${runtimeSettings.locale}:`, prompt);
		} catch (translationErr) {
			console.error(
				`Failed to translate prompt to ${runtimeSettings.locale}. Using english prompt:`,
				translationErr,
			);
		}
	}

	app.listen(PORT, () =>
		console.log(`API running on http://localhost:${PORT}`),
	);
})();
