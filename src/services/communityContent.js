export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_INSTRUCTIONS_LENGTH = 2000;
export const MAX_URL_LENGTH = 2000;
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 600;
export const MAX_QUIZ_QUESTIONS = 100;

const startsWith = (buffer, bytes) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
const isZip = (buffer) => startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
const isOleDocument = (buffer) => startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isPlainText = (buffer) => !buffer.includes(0);

const OFFICE = 'application/vnd.openxmlformats-officedocument';
// The stored content type comes from this table, never from the client, and each
// type is checked against the file's leading bytes so a renamed file is rejected.
const FILE_TYPES = {
  pdf: ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  jpg: ['image/jpeg', (b) => startsWith(b, [0xff, 0xd8, 0xff])],
  jpeg: ['image/jpeg', (b) => startsWith(b, [0xff, 0xd8, 0xff])],
  png: ['image/png', (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  webp: ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  doc: ['application/msword', isOleDocument],
  docx: [`${OFFICE}.wordprocessingml.document`, isZip],
  xls: ['application/vnd.ms-excel', isOleDocument],
  xlsx: [`${OFFICE}.spreadsheetml.sheet`, isZip],
  ppt: ['application/vnd.ms-powerpoint', isOleDocument],
  pptx: [`${OFFICE}.presentationml.presentation`, isZip],
  txt: ['text/plain', isPlainText],
  csv: ['text/csv', isPlainText],
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

export const sanitizeFileName = (value) => {
  const base = String(value ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/\s+/g, ' ').trim();
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const maxStem = 120 - extension.length;
  return `${stem.slice(0, Math.max(maxStem, 1))}${extension}`;
};

// Returns { fileName, contentType } for an acceptable upload, otherwise { error }.
export const inspectResource = (rawFileName, data) => {
  const fileName = sanitizeFileName(rawFileName);
  const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const rule = Object.hasOwn(FILE_TYPES, extension) ? FILE_TYPES[extension] : null;
  if (!rule) return { error: `File type not allowed. Use ${ALLOWED_EXTENSIONS.join(', ')}` };
  if (!data.length) return { error: 'File is empty' };
  if (data.length > MAX_RESOURCE_BYTES) return { error: 'File must be 10 MB or smaller' };
  if (!rule[1](data)) return { error: `File content does not match a .${extension} file` };
  return { fileName, contentType: rule[0] };
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const decodeBase64 = (value) => {
  if (typeof value !== 'string' || !value) return null;
  // Reject oversized payloads before allocating a buffer for them.
  if (value.length > Math.ceil((MAX_RESOURCE_BYTES * 4) / 3) + 4) return { tooLarge: true };
  const compact = value.replace(/\s/g, '');
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) return null;
  return { data: Buffer.from(compact, 'base64') };
};

export const isHttpUrl = (value) => {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
};

// Returns { value } for a valid quiz request, otherwise { error }.
export const parseQuiz = (body, now = new Date()) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { error: 'title required' };
  if (title.length > MAX_TITLE_LENGTH) return { error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` };

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return { error: `instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer` };
  }

  const startsAt = typeof body.startsAt === 'string' ? new Date(body.startsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) return { error: 'startsAt must be a valid date' };

  const durationMinutes = body.durationMinutes;
  if (!Number.isInteger(durationMinutes) || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    return { error: `durationMinutes must be a whole number between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}` };
  }
  if (startsAt.getTime() + durationMinutes * 60_000 <= now.getTime()) {
    return { error: 'The quiz window has already passed' };
  }

  const rawUrl = typeof body.testUrl === 'string' ? body.testUrl.trim() : '';
  if (rawUrl && !isHttpUrl(rawUrl)) return { error: 'testUrl must be a valid http or https link' };

  const questions = body.questions ?? [];
  if (!Array.isArray(questions) || questions.length > MAX_QUIZ_QUESTIONS) {
    return { error: `questions must be a list of up to ${MAX_QUIZ_QUESTIONS} items` };
  }
  const cleanedQuestions = [];
  for (const [index, question] of questions.entries()) {
    const prompt = typeof question?.prompt === 'string' ? question.prompt.trim() : '';
    const options = Array.isArray(question?.options) ? question.options.map((item) => typeof item === 'string' ? item.trim() : '') : [];
    const correctOption = typeof question?.correctOption === 'string' ? question.correctOption.trim().toUpperCase() : '';
    if (!prompt || prompt.length > 1000 || options.length !== 4 || options.some((item) => !item || item.length > 500) || !['A', 'B', 'C', 'D'].includes(correctOption)) {
      return { error: `Question ${index + 1} must have a prompt, four options and a correct option (A-D)` };
    }
    cleanedQuestions.push({ prompt, options, correctOption });
  }

  return { value: { title, instructions, startsAt, durationMinutes, testUrl: rawUrl || null, questions: cleanedQuestions } };
};

export const quizWindow = (quiz, now = new Date()) => {
  const startsAt = new Date(quiz.startsAt).getTime();
  const endsAt = startsAt + quiz.durationMinutes * 60_000;
  const status = now.getTime() < startsAt ? 'upcoming' : now.getTime() < endsAt ? 'live' : 'ended';
  return { status, endsAt: new Date(endsAt).toISOString() };
};

// Members only receive the test link while the quiz is live, so it cannot be used early.
export const presentQuiz = (quiz, { isAdmin, now = new Date() }) => {
  const { status, endsAt } = quizWindow(quiz, now);
  const { testUrl, ...rest } = quiz;
  return {
    ...rest,
    questions: (isAdmin || status === 'live')
      ? (quiz.questions ?? []).map(({ correctOption, ...question }) => ({
          ...question,
          ...(isAdmin ? { correctOption } : {}),
        }))
      : [],
    cameraRequired: true,
    hasTestUrl: Boolean(testUrl),
    status,
    endsAt,
    ...(isAdmin || status === 'live' ? { testUrl } : {}),
  };
};
