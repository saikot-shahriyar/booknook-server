import express from "express";
import {
    getAllBooks,
    getBookById,
    createBook,
    updateBook,
    deleteBook,
} from "../controllers/books.controller.js";
import { verifyAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

// GET /books - Public: Get all books (supports ?limit, ?category, ?userEmail)
router.get("/", getAllBooks);

// GET /books/:id - Public: Get single book by ID
router.get("/:id", getBookById);

// POST /books - Protected: Add a new book
router.post("/", verifyAuth, createBook);

// PATCH /books/:id - Protected: Update book (owner only)
router.patch("/:id", verifyAuth, updateBook);

// DELETE /books/:id - Protected: Delete book (owner only)
router.delete("/:id", verifyAuth, deleteBook);

export default router;
