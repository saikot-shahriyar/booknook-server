
import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let db;

const connectDB = async () => {
    try {
        await client.connect();

        db = client.db("booknook");

        await db.command({ ping: 1 });

        console.log("MongoDB connected successfully!");

        return db;
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
};

// Get database instance
const getDB = () => {
    if (!db) {
        throw new Error("Database is not connected!");
    }

    return db;
};

export { connectDB, getDB, client };
