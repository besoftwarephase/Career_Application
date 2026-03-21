
require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");
const cloudinary = require("cloudinary").v2;

const app = express();


/* ================= CLOUDINARY CONFIG ================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log("✅ Cloudinary Config Loaded");

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ================= HOME ROUTE ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "career.html"));
});

/* ================= ALLOWED FILE TYPES ================= */
const ALLOWED_MIMETYPES = [
  "application/pdf",                                                         // .pdf
  "application/msword",                                                      // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
];

const MIMETYPE_TO_EXT = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/* ================= MULTER (memory storage) ================= */
// Files are held in memory so we can:
//  1. Upload to Cloudinary via upload_stream (no temp files)
//  2. Attach the same buffer directly to the email
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, or DOCX files are allowed"), false);
    }
  },
});

/* ================= EMAIL SETUP ================= */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  }
});



/* ================= SUBMIT API ================= */
app.post("/submit", upload.single("resume"), async (req, res) => {
  try {
    console.log("BODY:", req.body);
    console.log("FILE:", req.file?.originalname, req.file?.mimetype);

    /* ================= VALIDATION ================= */
    if (!req.file) {
      return res.status(400).json({
        status: "FAILED",
        error: "Resume file is required (PDF, DOC, or DOCX)",
      });
    }

    const d = req.body;
    const ext = MIMETYPE_TO_EXT[req.file.mimetype];
    const isPdf = ext === "pdf";

    /* ================= UPLOAD TO CLOUDINARY ================= */
    const resumeURL = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "career/resumes",
          resource_type: "raw",              // supports pdf, doc, docx
          format: ext,
          public_id: `resume_${Date.now()}`,
          flags: isPdf ? "attachment:false" : "attachment", // PDF = viewable, DOC/DOCX = download
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(req.file.buffer);
    });

    console.log("✅ Resume uploaded:", resumeURL);

    /* ================= VERIFY EMAIL ================= */
    await transporter.verify();
    console.log("Email server ready");

    /* ================= EMAIL CONTENT ================= */
    const adminHTML = `
      <h2><strong>New Candidate Application Form<strong></h2>
      <hr/>
      
      <h4>Personal Information</h4>
      <p><b>Name:</b> ${d.name}</p>
      <p><b>Email:</b> ${d.email}</p>
      <p><b>Phone:</b> ${d.phone}</p>
      <p><b>Location:</b> ${d.location}</p>
      <p><b>Description:</b> ${d.describe}</p>

      <h4>Creative Assessment</h4>
      <p><b>Q1:</b> ${d.q_1}</p>
      <p><b>Q2:</b> ${d.q_2}</p>
      <p><b>Q3:</b> ${d.q_3}</p>
      <p><b>Q4:</b> ${d.q_4}</p>
       
      <h4>Open Position and Final details </h4>
      <p><b>Preferred Role:</b> ${d.preferred_role}</p>
      <p><b>Expected Salary:</b> ${d.expected_salary}</p>
      <p><b>Joining Date:</b> ${d.joining_date}</p>
      <p><b>Message:</b> ${d.message}</p>

      <p><b>Resume (${ext.toUpperCase()}):</b>
        <a href="${resumeURL}" target="_blank">
          ${isPdf ? "View Resume" : "Download Resume"}
        </a>
      </p>
      <p><i>The resume is also attached to this email.</i></p>
    `;

    const userHTML = `
      <div style="font-family:Arial,sans-serif;">
        <h2>Hi ${d.name},</h2>

        <p>We’ve received your application for the  <b> ${d.preferred_role} </b> role.</p>

        <p> will review it shortly,If your profile aligns with our requirements our team will reach out to you shortly.</p>

        <p>We appreciate the time you took to apply.</p>

        <br/>
        <p><b>Best Regards</b></p>
        <p>Bliend Team</p>
        <p>Marketing & Creative Agency</p>
      </div>
    `;

    /* ================= SEND EMAILS ================= */

    // 👉 Admin Email — resume attached directly from memory buffer
    await transporter.sendMail({
      from: `"Bliend Career Form" <${process.env.EMAIL_USER}>`,
      to: "ashabliend@gmail.com",
      cc: [
        "ashabliend@gmail.com",
        "nawinmoffl@gmail.com",
      ],
      replyTo: d.email,
      subject: `New Candidate – ${d.name} | ${d.preferred_role}`,
      html: adminHTML,
      attachments: [
        {
          filename: `${d.name.replace(/\s+/g, "_")}_Resume.${ext}`,
          content: req.file.buffer,
          contentType: req.file.mimetype,
        },
      ],
    });

    // 👉 Auto Reply to Candidate
    await transporter.sendMail({
      from: `"Bliend Careers" <${process.env.EMAIL_USER}>`,
      to: d.email,
      subject: `Application Received – ${d.preferred_role}`,
      html: userHTML,
    });

    /* ================= RESPONSE ================= */
    return res.status(200).json({
      status: "SUCCESS",
      message: "Application submitted successfully",
      resume_url: resumeURL,
    });
  } catch (err) {
    console.error("❌ ERROR:", err);

    return res.status(500).json({
      status: "FAILED",
      error: err.message || "Internal Server Error",
    });
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

