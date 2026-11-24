import "dotenv/config";
import dns from "node:dns";
import express from "express";
import cors from "cors";

import { connectDB } from "./config/db.js";
import booksRouter from "./routes/books.routes.js";
import borrowsRouter from "./routes/borrows.routes.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

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

// Books API
app.use("/books", booksRouter);

// Borrows API
app.use("/borrows", borrowsRouter);

// Start Server
const startServer = async () => {
    await connectDB();

    app.listen(PORT, () => {
        console.log(`BookNook Server running on port ${PORT}`);
    });
};

startServer();
