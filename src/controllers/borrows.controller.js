import { ObjectId } from "mongodb";
import { client, getDB } from "../config/db.js";

let indexEnsured = false;

/**
 * Ensures the compound unique index on { bookId: 1, userEmail: 1 } exists in borrows collection.
 * This guarantees no duplicate active borrows can occur even under race conditions.
 */
const ensureBorrowsIndex = async (db) => {
    if (!indexEnsured) {
        try {
            await db.collection("borrows").createIndex(
                { bookId: 1, userEmail: 1 },
                { unique: true }
            );
            indexEnsured = true;
        } catch (err) {
            console.error("Failed to ensure unique borrows index:", err);
        }
    }
};

/**
 * POST /borrows
 * Protected: Borrow a book copy.
 *
 * Requirements:
 * 1. Accepts bookId from request body.
 * 2. Authenticated user from req.user (name, email, id).
 * 3. Validates ObjectId and ensures book exists.
 * 4. Prevents duplicate active borrows for the same user and book.
 * 5. Atomically decrements availableCopies by 1 using $inc when availableCopies > 0.
 * 6. Returns 409 if no copies are available.
 * 7. Server-generates borrowDate and returnDate (exactly 7 days after borrowDate).
 * 8. Rolls back inventory if borrow record insertion fails.
 * 9. Returns 201 on success.
 */
export const createBorrow = async (req, res) => {
    let bookObjectId = null;
    let copyDecremented = false;

    try {
        const rawBookId = req.body?.bookId || req.body?.id;

        if (!rawBookId || typeof rawBookId !== "string" || !rawBookId.trim()) {
            return res.status(400).json({
                success: false,
                message: "Book ID is required.",
            });
        }

        const trimmedBookId = rawBookId.trim();

        if (!ObjectId.isValid(trimmedBookId) || new ObjectId(trimmedBookId).toString() !== trimmedBookId) {
            return res.status(400).json({
                success: false,
                message: "Invalid book ID format.",
            });
        }

        bookObjectId = new ObjectId(trimmedBookId);
        const db = getDB();
        await ensureBorrowsIndex(db);

        // Check if the book exists
        const existingBook = await db.collection("books").findOne({ _id: bookObjectId });
        if (!existingBook) {
            return res.status(404).json({
                success: false,
                message: "Book not found.",
            });
        }

        const userEmail = req.user.email;
        const userName = req.user.name || "Anonymous";
        const userId = req.user.id;

        // Check if user already has an active borrow for this book
        const existingBorrow = await db.collection("borrows").findOne({
            bookId: trimmedBookId,
            userEmail,
        });

        if (existingBorrow) {
            return res.status(400).json({
                success: false,
                message: "You have already borrowed this book.",
            });
        }

        // Atomically decrement availableCopies by 1 only if availableCopies > 0
        const updateResult = await db.collection("books").findOneAndUpdate(
            {
                _id: bookObjectId,
                availableCopies: { $gt: 0 },
            },
            {
                $inc: { availableCopies: -1 },
                $set: { updatedAt: new Date() },
            },
            { returnDocument: "after" }
        );

        if (!updateResult) {
            // Check if book exists but has 0 available copies
            const currentBook = await db.collection("books").findOne({ _id: bookObjectId });
            if (!currentBook) {
                return res.status(404).json({
                    success: false,
                    message: "Book not found.",
                });
            }

            return res.status(409).json({
                success: false,
                message: "No copies of this book are currently available.",
            });
        }

        copyDecremented = true;

        // Server-generated dates: returnDate is exactly 7 days (7 * 24 * 60 * 60 * 1000 ms) after borrowDate
        const borrowDate = new Date();
        const returnDate = new Date(borrowDate.getTime() + 7 * 24 * 60 * 60 * 1000);

        const borrowDoc = {
            bookId: trimmedBookId,
            bookTitle: updateResult.title,
            bookImage: updateResult.image || "",
            userEmail,
            userName,
            userId,
            borrowDate: borrowDate.toISOString(),
            returnDate: returnDate.toISOString(),
            createdAt: new Date(),
        };

        let insertResult;
        try {
            insertResult = await db.collection("borrows").insertOne(borrowDoc);
        } catch (insertError) {
            // Rollback inventory copy decrement on insertion failure
            await db.collection("books").updateOne(
                { _id: bookObjectId },
                {
                    $inc: { availableCopies: 1 },
                    $set: { updatedAt: new Date() },
                }
            );
            copyDecremented = false;

            if (insertError.code === 11000) {
                return res.status(400).json({
                    success: false,
                    message: "You have already borrowed this book.",
                });
            }

            console.error("Failed to insert borrow record; rolled back inventory:", insertError);
            return res.status(500).json({
                success: false,
                message: "Failed to record borrow transaction.",
            });
        }

        return res.status(201).json({
            success: true,
            message: "Book borrowed successfully.",
            data: {
                _id: insertResult.insertedId,
                ...borrowDoc,
            },
        });
    } catch (error) {
        console.error("Unexpected error in createBorrow:", error);

        // Safety rollback if an error occurred after decrementing
        if (copyDecremented && bookObjectId) {
            try {
                const db = getDB();
                await db.collection("books").updateOne(
                    { _id: bookObjectId },
                    {
                        $inc: { availableCopies: 1 },
                        $set: { updatedAt: new Date() },
                    }
                );
            } catch (rollbackError) {
                console.error("Failed to rollback decremented copy:", rollbackError);
            }
        }

        return res.status(500).json({
            success: false,
            message: "Failed to process borrow request.",
        });
    }
};

/**
 * GET /borrows
 * Protected: Get the currently authenticated user's borrow records.
 *
 * Requirements:
 * 1. Only returns borrow records belonging to the authenticated user (req.user.email).
 * 2. Never accepts a user email from query parameters or request body.
 * 3. Returns: _id, bookId, bookTitle, bookImage, userEmail, borrowDate, returnDate.
 *    (The `_id` of the borrow record is required by clients to call DELETE /borrows/:id.)
 * 4. Sorted by borrowDate descending (newest first).
 * 5. Returns an empty array when the user has no borrow records.
 * 6. Returns 200 on success.
 */
export const getBorrows = async (req, res) => {
    try {
        const db = getDB();
        const userEmail = req.user.email;

        const borrows = await db.collection("borrows")
            .find({ userEmail })
            .sort({ borrowDate: -1 })
            .toArray();

        const data = borrows.map((doc) => ({
            _id: doc._id,
            bookId: doc.bookId,
            bookTitle: doc.bookTitle,
            bookImage: doc.bookImage || "",
            userEmail: doc.userEmail,
            borrowDate: doc.borrowDate,
            returnDate: doc.returnDate,
        }));

        return res.status(200).json({
            success: true,
            count: data.length,
            data,
        });
    } catch (error) {
        console.error("Failed to fetch borrows:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch borrow records.",
        });
    }
};

/**
 * DELETE /borrows/:id
 * Protected: Return a borrowed book (restore 1 copy to inventory).
 *
 * Requirements:
 * 1. Validates the borrow record ID as a MongoDB ObjectId (400 if invalid).
 * 2. Finds the borrow record by ID and the authenticated user's email (req.user.email).
 * 3. Returns 404 if the record does not exist or does not belong to the current user.
 * 4. Finds the associated book using the stored bookId.
 * 5. Atomically increments availableCopies by 1 using $inc, guarded so it never
 *    exceeds totalCopies.
 * 6. Deletes the borrow record only after the inventory update succeeds.
 * 7. Duplicate returns: if the delete finds no record (already returned), the
 *    increment is compensated so inventory stays consistent; responds 404.
 * 8. Uses a MongoDB transaction when the deployment supports it (Atlas sharded
 *    clusters do); otherwise the compensation in 7 keeps the same guarantees.
 * 9. Never accepts a user email from request body or query parameters.
 * 10. Returns 200 on success.
 */
export const returnBorrow = async (req, res) => {
    let session = null;
    let incrementDone = false;
    let bookObjectId = null;
    let useTransaction = false;

    const abortTransactionSafely = async () => {
        if (!session) {
            return;
        }
        try {
            await session.abortTransaction();
        } catch (abortError) {
            console.error("Failed to abort transaction:", abortError);
        }
    };

    const endSessionSafely = async () => {
        if (!session) {
            return;
        }
        const s = session;
        session = null;
        try {
            await s.endSession();
        } catch (endError) {
            console.error("Failed to end session:", endError);
        }
    };

    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id) || new ObjectId(id).toString() !== id) {
            return res.status(400).json({
                success: false,
                message: "Invalid borrow ID format.",
            });
        }

        const borrowObjectId = new ObjectId(id);
        const userEmail = req.user.email;
        const db = getDB();

        // Check whether this deployment supports multi-document
        // transactions. MongoDB Atlas sharded/replica-set clusters do; standalone
        // servers (and Atlas M0, which runs standalone) do not. When they do not,
        // the compensation logic in this function provides the same guarantees.
        try {
            const hello = await db.command({ hello: 1 });
            useTransaction = hello.setName !== undefined || hello.msg === "isdbgrid";
        } catch (probeError) {
            console.error("Transaction support probe failed; using compensation mode:", probeError);
        }

        if (useTransaction) {
            session = client.startSession();
            session.startTransaction();
        }
        const opts = useTransaction ? { session } : undefined;

        // 1. Find the borrow record and verify it belongs to the authenticated user.
        const borrow = await db.collection("borrows").findOne(
            { _id: borrowObjectId, userEmail },
            opts
        );

        if (!borrow) {
            await abortTransactionSafely();
            return res.status(404).json({
                success: false,
                message: "Borrow record not found.",
            });
        }

        // 2. Find the associated book. If it does not exist, do not delete the
        //    borrow record: abort without changing anything.
        if (!borrow.bookId) {
            await abortTransactionSafely();
            return res.status(404).json({
                success: false,
                message: "Associated book not found.",
            });
        }

        try {
            bookObjectId = new ObjectId(borrow.bookId);
        } catch (err) {
            await abortTransactionSafely();
            return res.status(404).json({
                success: false,
                message: "Associated book not found.",
            });
        }

        const book = await db.collection("books").findOne({ _id: bookObjectId }, opts);
        if (!book) {
            await abortTransactionSafely();
            return res.status(404).json({
                success: false,
                message: "Associated book not found.",
            });
        }

        // 3. Guarded atomic increment: availableCopies + 1 must stay <= totalCopies.
        const updatedBook = await db.collection("books").findOneAndUpdate(
            {
                _id: bookObjectId,
                $expr: {
                    $lte: [
                        { $add: [{ $ifNull: ["$availableCopies", 0] }, 1] },
                        { $ifNull: ["$totalCopies", 0] },
                    ],
                },
            },
            {
                $inc: { availableCopies: 1 },
                $set: { updatedAt: new Date() },
            },
            { ...opts, returnDocument: "after" }
        );

        if (!updatedBook) {
            // The book is missing or already at totalCopies.
            const stillExists = await db.collection("books").findOne({ _id: bookObjectId }, opts);
            await abortTransactionSafely();
            if (!stillExists) {
                return res.status(404).json({
                    success: false,
                    message: "Associated book not found.",
                });
            }
            return res.status(409).json({
                success: false,
                message: "Book copies are already at maximum. This borrow may have already been returned.",
            });
        }

        incrementDone = true;

        // 4. Delete the borrow record only after the inventory update succeeded.
        const deleteResult = await db.collection("borrows").deleteOne(
            { _id: borrowObjectId, userEmail },
            opts
        );

        if (deleteResult.deletedCount === 0) {
            // Duplicate return: another request deleted this record between our
            // findOne and this delete. Undo the increment we just performed so the
            // inventory stays consistent, then report 404.
            await abortTransactionSafely();
            if (!useTransaction) {
                try {
                    await db.collection("books").updateOne(
                        { _id: bookObjectId },
                        { $inc: { availableCopies: -1 }, $set: { updatedAt: new Date() } }
                    );
                } catch (compErr) {
                    console.error("Failed to compensate inventory for duplicate return:", compErr);
                }
            }
            return res.status(404).json({
                success: false,
                message: "Borrow record not found or already returned.",
            });
        }

        incrementDone = false;

        if (useTransaction) {
            await session.commitTransaction();
        }

        return res.status(200).json({
            success: true,
            message: "Book returned successfully.",
            data: {
                _id: borrowObjectId,
                bookId: borrow.bookId,
                bookTitle: borrow.bookTitle,
            },
        });
    } catch (error) {
        // In transaction mode, aborting rolls back the increment and the delete.
        await abortTransactionSafely();
        if (!useTransaction && incrementDone && bookObjectId) {
            // Compensation (best effort) when the delete or something after the
            // increment failed without going through the duplicate path.
            try {
                await db.collection("books").updateOne(
                    { _id: bookObjectId },
                    { $inc: { availableCopies: -1 }, $set: { updatedAt: new Date() } }
                );
            } catch (compErr) {
                console.error("Failed to compensate inventory after error:", compErr);
            }
        }
        console.error("Unexpected error in returnBorrow:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to process book return.",
        });
    } finally {
        await endSessionSafely();
    }
};
