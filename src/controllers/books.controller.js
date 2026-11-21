import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const VALID_CATEGORIES = ["Fiction", "Science", "History", "Kids", "Others"];

/**
 * GET /books
 * Public: Retrieve all books with optional sorting, limit, and category filtering.
 */
export const getAllBooks = async (req, res) => {
    try {
        const db = getDB();

        const filter = {};

        // Optional category filter: /books?category=Fiction
        if (
            req.query.category &&
            typeof req.query.category === "string" &&
            req.query.category.trim().toLowerCase() !== "all"
        ) {
            filter.category = {
                $regex: new RegExp(`^${req.query.category.trim()}$`, "i"),
            };
        }

        // Optional filter for books added by a specific user: /books?userEmail=...
        if (req.query.userEmail && typeof req.query.userEmail === "string") {
            const email = req.query.userEmail.trim();
            filter.$or = [{ "addedBy.email": email }, { userEmail: email }];
        }

        let booksQuery = db
            .collection("books")
            .find(filter)
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
};

/**
 * GET /books/:id
 * Public: Retrieve a single book by its MongoDB ObjectId.
 */
export const getBookById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id) || new ObjectId(id).toString() !== id) {
            return res.status(400).json({
                success: false,
                message: "Invalid book ID format.",
            });
        }

        const db = getDB();
        const book = await db.collection("books").findOne({ _id: new ObjectId(id) });

        if (!book) {
            return res.status(404).json({
                success: false,
                message: "Book not found.",
            });
        }

        res.status(200).json({
            success: true,
            data: book,
        });
    } catch (error) {
        console.error("Failed to fetch book:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch book.",
        });
    }
};

/**
 * POST /books
 * Protected: Add a new book. Requires authenticated user in req.user.
 */
export const createBook = async (req, res) => {
    try {
        const {
            title,
            author,
            category,
            image,
            imageUrl,
            description,
            totalCopies,
            availableCopies,
        } = req.body;

        const coverImage = (image || imageUrl || "").trim();

        if (!title || typeof title !== "string" || !title.trim()) {
            return res.status(400).json({
                success: false,
                message: "Book title is required.",
            });
        }

        if (!author || typeof author !== "string" || !author.trim()) {
            return res.status(400).json({
                success: false,
                message: "Author is required.",
            });
        }

        if (!category || !VALID_CATEGORIES.includes(category)) {
            return res.status(400).json({
                success: false,
                message: `Category must be one of: ${VALID_CATEGORIES.join(", ")}.`,
            });
        }

        if (!coverImage) {
            return res.status(400).json({
                success: false,
                message: "Book cover image URL is required.",
            });
        }

        if (!description || typeof description !== "string" || !description.trim()) {
            return res.status(400).json({
                success: false,
                message: "Book description is required.",
            });
        }

        const total = Number(totalCopies);
        if (!Number.isInteger(total) || total < 1) {
            return res.status(400).json({
                success: false,
                message: "totalCopies must be a positive integer.",
            });
        }

        let available = total;
        if (availableCopies !== undefined && availableCopies !== null) {
            const avail = Number(availableCopies);
            if (!Number.isInteger(avail) || avail < 0 || avail > total) {
                return res.status(400).json({
                    success: false,
                    message: "availableCopies must be an integer between 0 and totalCopies.",
                });
            }
            available = avail;
        }

        const db = getDB();

        const newBook = {
            title: title.trim(),
            author: author.trim(),
            category,
            image: coverImage,
            description: description.trim(),
            totalCopies: total,
            availableCopies: available,
            addedBy: {
                name: req.user.name || "Anonymous",
                email: req.user.email,
                id: req.user.id,
            },
            userName: req.user.name || "Anonymous",
            userEmail: req.user.email,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await db.collection("books").insertOne(newBook);

        res.status(201).json({
            success: true,
            message: "Book added successfully.",
            data: {
                _id: result.insertedId,
                ...newBook,
            },
        });
    } catch (error) {
        console.error("Failed to create book:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create book.",
        });
    }
};

/**
 * PATCH /books/:id
 * Protected: Update an existing book. Only the creator who added it can update.
 */
export const updateBook = async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id) || new ObjectId(id).toString() !== id) {
            return res.status(400).json({
                success: false,
                message: "Invalid book ID format.",
            });
        }

        const db = getDB();
        const existingBook = await db.collection("books").findOne({ _id: new ObjectId(id) });

        if (!existingBook) {
            return res.status(404).json({
                success: false,
                message: "Book not found.",
            });
        }

        // Authorization check: Only user who added can update
        const userEmail = req.user.email;
        const userId = req.user.id;
        const isOwner =
            (existingBook.addedBy?.email && existingBook.addedBy.email === userEmail) ||
            (existingBook.userEmail && existingBook.userEmail === userEmail) ||
            (existingBook.addedBy?.id && existingBook.addedBy.id === userId);

        if (!isOwner) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to update this book.",
            });
        }

        // availableCopies must not be controlled directly by client in PATCH
        if (req.body.availableCopies !== undefined) {
            return res.status(400).json({
                success: false,
                message: "availableCopies cannot be updated directly.",
            });
        }

        const updateData = {};
        const {
            title,
            author,
            category,
            image,
            imageUrl,
            description,
            totalCopies,
        } = req.body;

        if (title !== undefined) {
            if (typeof title !== "string" || !title.trim()) {
                return res.status(400).json({ success: false, message: "Title cannot be empty." });
            }
            updateData.title = title.trim();
        }

        if (author !== undefined) {
            if (typeof author !== "string" || !author.trim()) {
                return res.status(400).json({ success: false, message: "Author cannot be empty." });
            }
            updateData.author = author.trim();
        }

        if (category !== undefined) {
            if (!VALID_CATEGORIES.includes(category)) {
                return res.status(400).json({
                    success: false,
                    message: `Category must be one of: ${VALID_CATEGORIES.join(", ")}.`,
                });
            }
            updateData.category = category;
        }

        const coverImage = image !== undefined ? image : imageUrl;
        if (coverImage !== undefined) {
            if (typeof coverImage !== "string" || !coverImage.trim()) {
                return res.status(400).json({ success: false, message: "Image URL cannot be empty." });
            }
            updateData.image = coverImage.trim();
        }

        if (description !== undefined) {
            if (typeof description !== "string" || !description.trim()) {
                return res.status(400).json({ success: false, message: "Description cannot be empty." });
            }
            updateData.description = description.trim();
        }

        if (totalCopies !== undefined) {
            const newTotal = Number(totalCopies);
            if (!Number.isInteger(newTotal) || newTotal < 1) {
                return res.status(400).json({
                    success: false,
                    message: "totalCopies must be a positive integer.",
                });
            }

            const currentTotal = Number(existingBook.totalCopies) || 0;
            const currentAvailable =
                existingBook.availableCopies !== undefined
                    ? Number(existingBook.availableCopies)
                    : currentTotal;
            const borrowedCopies = Math.max(0, currentTotal - currentAvailable);

            if (newTotal < borrowedCopies) {
                return res.status(400).json({
                    success: false,
                    message: `totalCopies cannot be less than the number of currently borrowed copies (${borrowedCopies} borrowed).`,
                });
            }

            const newAvailable = newTotal - borrowedCopies;
            updateData.totalCopies = newTotal;
            updateData.availableCopies = newAvailable;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid fields provided for update.",
            });
        }

        updateData.updatedAt = new Date();

        const updatedBook = await db.collection("books").findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: updateData },
            { returnDocument: "after" }
        );

        res.status(200).json({
            success: true,
            message: "Book updated successfully.",
            data: updatedBook,
        });
    } catch (error) {
        console.error("Failed to update book:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update book.",
        });
    }
};

/**
 * DELETE /books/:id
 * Protected: Delete an existing book. Only the creator who added it can delete.
 */
export const deleteBook = async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id) || new ObjectId(id).toString() !== id) {
            return res.status(400).json({
                success: false,
                message: "Invalid book ID format.",
            });
        }

        const db = getDB();
        const existingBook = await db.collection("books").findOne({ _id: new ObjectId(id) });

        if (!existingBook) {
            return res.status(404).json({
                success: false,
                message: "Book not found.",
            });
        }

        // Authorization check: Only user who added can delete
        const userEmail = req.user.email;
        const userId = req.user.id;
        const isOwner =
            (existingBook.addedBy?.email && existingBook.addedBy.email === userEmail) ||
            (existingBook.userEmail && existingBook.userEmail === userEmail) ||
            (existingBook.addedBy?.id && existingBook.addedBy.id === userId);

        if (!isOwner) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to delete this book.",
            });
        }

        await db.collection("books").deleteOne({ _id: new ObjectId(id) });

        res.status(200).json({
            success: true,
            message: "Book deleted successfully.",
        });
    } catch (error) {
        console.error("Failed to delete book:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete book.",
        });
    }
};
