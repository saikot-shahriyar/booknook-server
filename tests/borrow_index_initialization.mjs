import "dotenv/config";
// import dns from "node:dns";
import { connectDB, getDB } from "../src/config/db.js";
import { ObjectId } from "mongodb";

// dns.setServers(["8.8.8.8", "8.8.4.4"]);

const createdBooks = [];

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

function makeReq(userEmail, bookId) {
    return {
        user: {
            id: `regression-borrower-${Math.random().toString(36).slice(2, 10)}`,
            name: "Regression Borrower",
            email: userEmail,
        },
        body: { bookId },
    };
}

async function insertIsolatedBook(db, title, available) {
    const now = new Date();
    const book = {
        _id: new ObjectId(),
        title,
        author: "Regression Author",
        category: "Fiction",
        image: `http://example.com/${title.replace(/\s+/g, "-").toLowerCase()}.jpg`,
        description: "Regression test book",
        totalCopies: available,
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

async function getAvailableCopies(db, bookId) {
    const book = await db.collection("books").findOne({ _id: bookId });
    return book ? book.availableCopies : null;
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

// Fresh module instance per scenario so the module-level cached
// `borrowsIndexPromise` starts as null (fresh initialization state).
let scenario = 0;
const freshController = () =>
    import(`../src/controllers/borrows.controller.js?scenario=${Date.now()}-${(scenario += 1)}`);

async function main() {
    await connectDB();
    const db = getDB();

    // --- Scenario 1: index creation succeeds -> borrowing proceeds normally ---
    {
        const { createBorrow } = await freshController();
        const book = await insertIsolatedBook(db, "Regression Borrow Index OK", 2);
        const email = "regression-index-ok@example.com";

        const res = makeRes();
        await createBorrow(makeReq(email, book._id.toString()), res);

        check(
            "index-ok: 201 + success body",
            res.statusCode === 201 && res.body && res.body.success === true,
            { statusCode: res.statusCode, body: res.body }
        );
        const copies = await getAvailableCopies(db, book._id);
        check("index-ok: availableCopies decremented by 1", copies === 1, { copies });
        const existingBorrow = await db.collection("borrows").findOne({
            bookId: book._id.toString(),
            userEmail: email,
        });
        check("index-ok: borrow doc inserted", existingBorrow !== null);

        const indexes = await db.collection("borrows").indexes();
        const compoundUnique = indexes.find(
            (ix) => ix.unique === true && ix.key && ix.key.bookId === 1 && ix.key.userEmail === 1
        );
        check("index-ok: unique compound index { bookId: 1, userEmail: 1 } exists", Boolean(compoundUnique), {
            indexes: indexes.map((ix) => `${ix.name}:unique=${ix.unique}`),
        });
    }

    // --- Scenario 2: duplicate-borrow prevention still works ---
    {
        const { createBorrow } = await freshController();
        const book = await insertIsolatedBook(db, "Regression Borrow Duplicate", 1);
        const email = "regression-duplicate@example.com";

        const res1 = makeRes();
        await createBorrow(makeReq(email, book._id.toString()), res1);
        check("duplicate: first borrow succeeds", res1.statusCode === 201, { statusCode: res1.statusCode });

        const res2 = makeRes();
        await createBorrow(makeReq(email, book._id.toString()), res2);
        check(
            "duplicate: second borrow rejected 400 'already borrowed'",
            res2.statusCode === 400 && res2.body && res2.body.message === "You have already borrowed this book.",
            { statusCode: res2.statusCode, body: res2.body }
        );
    }

    // --- Scenario 3: index creation fails -> 503; retry succeeds on same instance ---
    {
        const { createBorrow } = await freshController();
        const book = await insertIsolatedBook(db, "Regression Borrow Index Fail", 3);
        const email = "regression-index-fail@example.com";

        const realCollection = db.collection.bind(db);
        const failingBorrows = {
            createIndex: async () => {
                throw new Error("simulated index creation failure");
            },
        };
        db.collection = (name, opts) =>
            name === "borrows" ? failingBorrows : realCollection(name, opts);

        const resFail = makeRes();
        await createBorrow(makeReq(email, book._id.toString()), resFail);
        db.collection = realCollection; // restore before the retry

        const copiesAfterFail = await getAvailableCopies(db, book._id);
        check(
            "index-fail: 503 + success:false message",
            resFail.statusCode === 503 && resFail.body && resFail.body.success === false,
            { statusCode: resFail.statusCode, body: resFail.body }
        );
        check("index-fail: availableCopies unchanged (3)", copiesAfterFail === 3, { copies: copiesAfterFail });
        const failedBorrows = await db.collection("borrows").countDocuments({
            bookId: book._id.toString(),
            userEmail: email,
        });
        check("index-fail: no borrow record inserted", failedBorrows === 0, { count: failedBorrows });

        // Retry: failed initialization must not be cached forever.
        const resRetry = makeRes();
        await createBorrow(makeReq(email, book._id.toString()), resRetry);
        check(
            "retry: 201 after failed initialization",
            resRetry.statusCode === 201 && resRetry.body && resRetry.body.success === true,
            { statusCode: resRetry.statusCode, body: resRetry.body }
        );
        const copiesAfterRetry = await getAvailableCopies(db, book._id);
        check("retry: availableCopies decremented by 1 (3 -> 2)", copiesAfterRetry === 2, { copies: copiesAfterRetry });
    }

    // --- Scenario 4: concurrent first-time borrow requests share index init ---
    {
        const { createBorrow } = await freshController();
        const realCollection = db.collection.bind(db);
        let createIndexCalls = 0;

        db.collection = (name, opts) => {
            const coll = realCollection(name, opts);
            if (name !== "borrows") {
                return coll;
            }
            const realCreateIndex = coll.createIndex.bind(coll);
            coll.createIndex = async (...args) => {
                createIndexCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 100)); // widen the race window
                return realCreateIndex(...args);
            };
            return coll;
        };

        const books = [];
        for (let i = 0; i < 5; i += 1) {
            books.push(await insertIsolatedBook(db, `Regression Concurrent ${i + 1}`, 1));
        }
        const email = "regression-concurrent@example.com";

        const responses = await Promise.all(
            books.map((book) => {
                const res = makeRes();
                return createBorrow(makeReq(email, book._id.toString()), res).then(() => res);
            })
        );

        check(
            "concurrent: all 5 requests 201",
            responses.every((r) => r.statusCode === 201),
            { statuses: responses.map((r) => r.statusCode) }
        );
        check("concurrent: createIndex called exactly once (shared init)", createIndexCalls === 1, { createIndexCalls });

        db.collection = realCollection;
    }

    // --- Cleanup of isolated test data ---
    await db.collection("borrows").deleteMany({ bookId: { $in: createdBooks.map((id) => id.toString()) } });
    await db.collection("books").deleteMany({ _id: { $in: createdBooks } });
    console.log(`Cleanup: removed ${createdBooks.length} isolated test books`);

    console.log(`\nBorrow index initialization tests: passed=${passed}, failed=${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error("FATAL:", error);
    process.exit(1);
});
