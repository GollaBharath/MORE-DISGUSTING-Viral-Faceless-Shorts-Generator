import express from "express";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

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

app.use(express.json({ limit: "10mb" })); // JSON + base64 handling

async function proxyTTSRequest(req, res) {
	const text = req.body?.text ?? req.query?.text;
	let speakerId =
		req.body?.speaker_id ??
		req.query?.speaker_id ??
		process.env.COQUI_SPEAKER_ID;
	const languageId =
		req.body?.language_id ??
		req.query?.language_id ??
		process.env.COQUI_LANGUAGE_ID ??
		LOCALE_LANGUAGE_MAP[String(LOCALE || "").toLowerCase()] ??
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
	if (!audio || !subtitles) return res.status(400).send("Missing parameters");

	orientation = normalizeOrientation(orientation || DEFAULT_VIDEO_ORIENTATION);
	if (orientation === "custom") {
		width = parsePositiveInt(width) || DEFAULT_VIDEO_WIDTH;
		height = parsePositiveInt(height) || DEFAULT_VIDEO_HEIGHT;
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
		const subPath = `${tmp}/sub.srt`;
		const assPath = `${tmp}/sub.ass`;
		const outputPath = `${tmp}/output.mp4`;

		fs.writeFileSync(audioPath, Buffer.from(audio, "base64"));
		fs.writeFileSync(subPath, subtitles);

		let videoFilePath;
		let startOffset = 0;

		// If video is not provided, select a random default_ video
		if (!video) {
			const allFiles = fs.readdirSync("/mnt/videos");
			const videoFiles = allFiles.filter((f) =>
				/\.(mp4|mov|mkv|webm)$/i.test(f),
			);
			const defaultVideos = videoFiles.filter((f) => f.startsWith("default_"));
			const candidates = defaultVideos.length > 0 ? defaultVideos : videoFiles;
			if (candidates.length === 0)
				throw new Error("No video files found in /mnt/videos");
			video = candidates[Math.floor(Math.random() * candidates.length)];
			videoFilePath = path.join("/mnt/videos", video);

			const videoDuration = await getDuration(videoFilePath);
			const audioDuration = await getDuration(audioPath);
			const delta = Math.max(videoDuration - audioDuration - 1, 0);
			startOffset = delta > 0 ? Math.random() * delta : 0;
		} else {
			videoFilePath = path.join("/mnt/videos", video);
			if (!fs.existsSync(videoFilePath))
				return res.status(404).send("Video file not found");
		}

		// Generate styled ASS subtitles
		await execPromise(`ffmpeg -y -i "${subPath}" "${assPath}"`);
		await execPromise(
			`sed -i '/^Style:/c\\Style: Default,Montserrat ExtraBold,${fontsize},&H00FFFFFF,&H00000000,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,${outline},2,10,10,10,1' "${assPath}"`,
		);
		await execPromise(
			`grep -q "WrapStyle" "${assPath}" && sed -i 's/WrapStyle.*/WrapStyle: 0/' "${assPath}" || sed -i '/^\\[Script Info\\]/a WrapStyle: 0' "${assPath}"`,
		);

		const videoFilter = buildVideoFilter(assPath, orientation, width, height);

		// Burn subtitles, combine video + audio
		await execPromise(
			`ffmpeg -y -ss ${startOffset.toFixed(2)} -i "${videoFilePath}" -i "${audioPath}" -vf "${videoFilter}" -map 0:v:0 -map 1:a:0 -c:v libx264 -c:a aac -shortest "${outputPath}"`,
		);

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
	const speakerId = process.env.COQUI_SPEAKER_ID;
	const languageId =
		process.env.COQUI_LANGUAGE_ID ||
		LOCALE_LANGUAGE_MAP[String(LOCALE || "").toLowerCase()] ||
		"en";
	res.json({ speakerId: speakerId || null, languageId });
});

app.get("/video-config", (_req, res) => {
	res.json({
		defaultOrientation: normalizeOrientation(DEFAULT_VIDEO_ORIENTATION),
		defaultWidth: DEFAULT_VIDEO_WIDTH > 0 ? DEFAULT_VIDEO_WIDTH : null,
		defaultHeight: DEFAULT_VIDEO_HEIGHT > 0 ? DEFAULT_VIDEO_HEIGHT : null,
	});
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
	if (!geometry) {
		return `subtitles=${assPath}:fontsdir=/app/fonts`;
	}

	const { width: targetWidth, height: targetHeight } = geometry;
	return `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},subtitles=${assPath}:fontsdir=/app/fonts`;
}

(async () => {
	// first thing we do is check if locale is different from english, if so we ask gemini to translate the prompt to the locale language
	if (LOCALE !== "english") {
		try {
			prompt = await generateTextWithFallback([
				{
					text: `System: You are a professional translator. Please translate the following prompt from english to ${LOCALE}. Ensure the translation is accurate and meaning is preserved. JSON contents MUST be translated in ${LOCALE} too, that's mandatory. Omit the system prompt from the translation and translate only user content, ensure full prompt is translated (do not miss any part, and DO NOT add any additional part not in the prompt).\n\n User:`,
				},
				{ text: prompt },
			]);
			console.log(`Prompt translated to ${LOCALE}:`, prompt);
		} catch (translationErr) {
			console.error(
				`Failed to translate prompt to ${LOCALE}. Using english prompt:`,
				translationErr,
			);
		}
	}

	app.listen(PORT, () =>
		console.log(`API running on http://localhost:${PORT}`),
	);
})();
