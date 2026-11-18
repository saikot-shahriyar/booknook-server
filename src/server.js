import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(
    cors({
        origin: process.env.CLIENT_URL,
    })
);

app.use(express.json());

// Health Check API
app.get("/api/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "BookNook Server is running!",
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`BookNook Server running on port ${PORT}`);
});
