require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const { Resend } = require("resend");
const cloudinary = require("cloudinary").v2;

const app = express();

/* ================= CLOUDINARY CONFIG ================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log("Cloudinary Config Loaded");

/* ================= RESEND EMAIL SETUP ================= */
// Resend works perfectly on Render free tier — no SMTP port blocking issues
const resend = new Resend(process.env.RESEND_API_KEY);
console.log(`RESEND_API_KEY : ${process.env.RESEND_API_KEY ? "set" : "NOT SET — emails will fail"}`);

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ================= HOME ROUTE ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "career.html"));
});

/* ================= HEALTH CHECK ================= */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ================= FILE SETTINGS ================= */
const ALLOWED_MIMETYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MIMETYPE_TO_EXT = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/* ================= MULTER ================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, DOCX files are allowed"), false);
    }
  },
});

/* ================= CLOUDINARY UPLOAD HELPER ================= */
function uploadToCloudinary(buffer, ext) {
  const isPdf = ext === "pdf";

  return Promise.race([
    new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "career/resumes",
          resource_type: "raw",
          format: ext,
          public_id: `resume_${Date.now()}`,
          flags: isPdf ? "attachment:false" : "attachment",
        },
        (err, result) => {
          if (err) return reject(err);
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cloudinary upload timed out after 10s")), 10000)
    ),
  ]);
}

/* ================= EMAIL HELPER ================= */
async function sendEmailsInBackground(data, fileBuffer, ext, resumeURL) {
  const adminHTML = `
    <h2 style="color:#333">New Job Application</h2>
    <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 12px;font-weight:bold">Name</td><td style="padding:6px 12px">${data.name}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold">Email</td><td style="padding:6px 12px">${data.email}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold">Phone</td><td style="padding:6px 12px">${data.phone}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold">Role</td><td style="padding:6px 12px">${data.preferred_role}</td></tr>
    </table>
    <p style="margin-top:16px">
      <a href="${resumeURL}" style="background:#4F46E5;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">
        View Resume
      </a>
    </p>
  `;

  const userHTML = `
    <h2 style="color:#333">Application Received!</h2>
    <p style="font-family:sans-serif;font-size:14px">Hi <strong>${data.name}</strong>,</p>
    <p style="font-family:sans-serif;font-size:14px">
      Thank you for applying for the <strong>${data.preferred_role}</strong> position at Bliend.
      We have received your application and will review it shortly.
    </p>
    <p style="font-family:sans-serif;font-size:14px">We will be in touch soon!</p>
    <p style="font-family:sans-serif;font-size:14px;color:#888">— The Bliend Team</p>
  `;

  console.log(`Sending emails for: ${data.name} <${data.email}>`);

  try {
    // Both emails sent in parallel
    const [adminResult, userResult] = await Promise.all([

      // Email 1: Admin notification with resume attached
      resend.emails.send({
        from: "Bliend Careers <onboarding@resend.dev>", // works without a custom domain
        to: "ashabliend@gmail.com",
        subject: `New Candidate – ${data.name} (${data.preferred_role})`,
        html: adminHTML,
        attachments: [
          {
            filename: `${data.name}_Resume.${ext}`,
            content: fileBuffer, // Buffer works directly with Resend
          },
        ],
      }),

      // Email 2: Confirmation to applicant
      resend.emails.send({
        from: "Bliend Careers <onboarding@resend.dev>",
        to: data.email,
        subject: "Your application has been received – Bliend",
        html: userHTML,
      }),

    ]);

    console.log("Admin email sent! ID:", adminResult.data?.id);
    console.log("User email sent!  ID:", userResult.data?.id);

    // Log any soft errors returned by Resend
    if (adminResult.error) console.error("Admin email error:", adminResult.error);
    if (userResult.error) console.error("User email error:", userResult.error);

  } catch (err) {
    console.error("EMAIL SEND FAILED");
    console.error("   Message:", err.message);
    console.error("   Check your RESEND_API_KEY in Render environment variables");
    console.error("   Get your key at: https://resend.com/api-keys");
  }
}

/* ================= SUBMIT API ================= */
app.post("/submit", upload.single("resume"), async (req, res) => {
  try {
    console.log("New submission from:", req.body?.name);
    console.log("File:", req.file?.originalname, `(${req.file?.size} bytes)`);

    /* ── Validation ── */
    if (!req.file) {
      return res.status(400).json({
        status: "FAILED",
        error: "Resume file is required.",
      });
    }

    const requiredFields = ["name", "email", "phone", "preferred_role"];
    for (const field of requiredFields) {
      if (!req.body[field] || !req.body[field].toString().trim()) {
        return res.status(400).json({
          status: "FAILED",
          error: `Missing required field: ${field}`,
        });
      }
    }

    const d = req.body;
    const ext = MIMETYPE_TO_EXT[req.file.mimetype];

    /* ── Upload to Cloudinary ── */
    let resumeURL;
    try {
      resumeURL = await uploadToCloudinary(req.file.buffer, ext);
      console.log("Cloudinary upload done:", resumeURL);
    } catch (cloudErr) {
      console.error("Cloudinary failed:", cloudErr.message);
      return res.status(500).json({
        status: "FAILED",
        error: "File upload failed. Please try again.",
      });
    }

    /* ── Respond to client immediately ── */
    res.status(200).json({
      status: "SUCCESS",
      message: "Application submitted successfully! You'll receive a confirmation email shortly.",
      resume_url: resumeURL,
    });

    /* ── Emails fire in background after response is sent ── */
    sendEmailsInBackground(d, req.file.buffer, ext, resumeURL);

  } catch (err) {
    console.error("Unhandled error in /submit:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({
        status: "FAILED",
        error: "Something went wrong. Please try again.",
      });
    }
  }
});

/* ================= MULTER ERROR HANDLER ================= */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        status: "FAILED",
        error: "File is too large. Maximum size is 5MB.",
      });
    }
    return res.status(400).json({ status: "FAILED", error: err.message });
  }
  if (err && err.message) {
    return res.status(400).json({ status: "FAILED", error: err.message });
  }
  next(err);
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment   : ${process.env.NODE_ENV || "development"}`);
  console.log(`RESEND_API_KEY: ${process.env.RESEND_API_KEY ? "set" : " NOT SET"}`);
  console.log(`CLOUDINARY    : ${process.env.CLOUDINARY_CLOUD_NAME || " NOT SET"}`);
});