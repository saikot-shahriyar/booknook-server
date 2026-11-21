import express from "express";
import { createBorrow, getBorrows, returnBorrow } from "../controllers/borrows.controller.js";
import { verifyAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

// POST /borrows - Protected: Borrow a book
router.post("/", verifyAuth, createBorrow);

// GET /borrows - Protected: Get the authenticated user's borrow records
router.get("/", verifyAuth, getBorrows);

// DELETE /borrows/:id - Protected: Return a borrowed book
router.delete("/:id", verifyAuth, returnBorrow);

export default router;
