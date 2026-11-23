/**
 * Regression tests for the return-borrow endpoint (DELETE /borrows/:id).
 *
 * Run with: node tests/return_borrow.regression.mjs
 *
 * Uses isolated test data only: books and borrows are inserted with fresh
 * ObjectIds and the "regression-" emails, and the isolated test documents
 * are removed at the end. Pre-existing MongoDB records are never modified
 * or deleted by the tests.
 */

import "dotenv/config";
import dns from "node:dns";
import { connectDB } from "../src/config/db.js";
import { returnBorrow } from "../src/controllers/borrows.controller.js";
import { ObjectId } from "mongodb";

// Match src/server.js: the environment's default resolver cannot resolve the
// Atlas host, so use the same public DNS servers the app sets at startup.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const createdBooks = [];
const createdBorrows = [];

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

async function insertIsolatedBook(db, title, total, available) {
    const now = new Date();
    const book = {
        _id: new ObjectId(),
        title,
        author: "Regression Author",
        category: "Fiction",
        image: `http://example.com/${title}.jpg`,
        description: "Regression test book",
        totalCopies: total,
        availableCopies: available,
        addedBy: { name: "Regression User", email: "regression@example.com", id: "regression-book-user" },
        userName: "Regression User",
        userEmail: "regression@example.com",
        createdAt: now,
        updatedAt: now,
    };
    await db.collection("books").insertOne(book);
    createdBooks.push(book._id);
    return book;
}

async function insertIsolatedBorrow(db, bookIdStr, userEmail) {
    const now = new Date();
    const borrow = {
        _id: new ObjectId(),
        bookId: bookIdStr,
        bookTitle: "Regression Book Title",
        bookImage: "",
        userEmail,
        userName: "Regression User",
        userId: `regression-user-${Math.random().toString(36).slice(2, 10)}`,
        borrowDate: now.toISOString(),
        returnDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
    };
    await db.collection("borrows").insertOne(borrow);
    createdBorrows.push(borrow._id);
    return borrow;
}

function makeReq(userEmail, borrowId) {
    return {
        user: {
            id: `regression-user-${Math.random().toString(36).slice(2, 10)}`,
            name: "Regression User",
            email: userEmail,
        },
        params: { id: borrowId },
    };
}

let passed = 0;
let failed = 0;
function check(name, condition, extra) {
    if (condition) {
        passed += 1;
        console.log(`[PASS] ${name}`);
    } else {
        failed += 1;
        console.log(`[FAIL] ${name}${extra ? " :: " + JSON.stringify(extra) : ""}`);
    }
}

async function main() {
    const db = await connectDB();
    const books = db.collection("books");
    const borrows = db.collection("borrows");

    // --- Test 1: owner returns a normal borrow ---
    {
        const book = await insertIsolatedBook(db, "Regression Normal Return", 2, 1);
        const borrow = await insertIsolatedBorrow(db, book._id.toString(), "regression-normal@example.com");
        const res = makeRes();
        await returnBorrow(makeReq("regression-normal@example.com", borrow._id.toString()), res);

        check("owner returns normal borrow: 200 + success", res.statusCode === 200 && res.body && res.body.success === true, { statusCode: res.statusCode, body: res.body });
        check("owner returns normal borrow: borrow deleted", (await borrows.findOne({ _id: borrow._id })) === null);
        const after = await books.findOne({ _id: book._id });
        check("owner returns normal borrow: availableCopies incremented by 1", after && after.availableCopies === 2, { availableCopies: after && after.availableCopies });
    }

    // --- Test 2: owner returns an orphan borrow (book no longer exists) ---
    {
        const ghostBookId = new ObjectId().toString(); // never inserted into books
        const borrow = await insertIsolatedBorrow(db, ghostBookId, "regression-orphan@example.com");
        const booksBefore = await books.countDocuments();
        const res = makeRes();
        await returnBorrow(makeReq("regression-orphan@example.com", borrow._id.toString()), res);

        check("owner returns orphan borrow: 200 + success", res.statusCode === 200 && res.body && res.body.success === true, { statusCode: res.statusCode, body: res.body });
        check("owner returns orphan borrow: borrow deleted", (await borrows.findOne({ _id: borrow._id })) === null);
        const booksAfter = await books.countDocuments();
        check("owner returns orphan borrow: no book inventory updated", booksAfter === booksBefore, { booksBefore, booksAfter });
    }

    // --- Test 3: another user attempts to return an orphan borrow ---
    {
        const ghostBookId = new ObjectId().toString();
        const borrow = await insertIsolatedBorrow(db, ghostBookId, "regression-orphan-owner@example.com");
        const res = makeRes();
        await returnBorrow(makeReq("regression-other-user@example.com", borrow._id.toString()), res);

        check("other user returns orphan borrow: rejected (404)", res.statusCode === 404 && res.body && res.body.success === false, { statusCode: res.statusCode, body: res.body });
        check("other user returns orphan borrow: record remains", (await borrows.findOne({ _id: borrow._id })) !== null);
    }

    // --- Test 4: invalid borrow ID (existing behavior) ---
    {
        const res = makeRes();
        await returnBorrow(makeReq("regression-normal@example.com", "notanobjectid"), res);
        check("invalid borrow ID: 400 (unchanged)", res.statusCode === 400 && res.body && res.body.success === false, { statusCode: res.statusCode, body: res.body });
    }

    // --- Test 5: missing borrow record (existing behavior) ---
    {
        const missingId = new ObjectId().toString();
        const res = makeRes();
        await returnBorrow(makeReq("regression-normal@example.com", missingId), res);
        check("missing borrow record: 404 (unchanged)", res.statusCode === 404 && res.body && res.body.success === false, { statusCode: res.statusCode, body: res.body });
    }

    // --- Cleanup of isolated test data ---
    await borrows.deleteMany({ _id: { $in: createdBorrows } });
    await books.deleteMany({ _id: { $in: createdBooks } });
    console.log(`Cleanup: removed ${createdBorrows.length} borrows, ${createdBooks.length} books`);

    console.log(`\nReturn-borrow regression tests: passed=${passed}, failed=${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error("FATAL:", error);
    process.exit(1);
});
