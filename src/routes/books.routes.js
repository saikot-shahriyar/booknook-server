
import express from "express";
import { getDB } from "../config/db.js";

const router = express.Router();

// GET /books - Get all books
router.get("/", async (req, res) => {
    try {
        const db = getDB();

        let booksQuery = db
            .collection("books")
            .find()
            .sort({ createdAt: -1 });

        // Optional limit: /books?limit=6
        const limit = Number(req.query.limit);

        if (Number.isInteger(limit) && limit > 0) {
            booksQuery = booksQuery.limit(limit);
        }

        const books = await booksQuery.toArray();

        res.status(200).json({
            success: true,
            count: books.length,
            data: books,
        });
    } catch (error) {
        console.error("Failed to fetch books:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch books.",
        });
    }
});

export default router;
