import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { promisify } from 'util';
import fetch from 'node-fetch'; // Install node-fetch: npm install node-fetch@2

// Load environment variables from .env file
dotenv.config();

// Initialize express app
const app = express();

// Define allowed origins
const allowedOrigins = [process.env.FRONTEND_URL || 'https://selfie-swap.vercel.app/'];

// Enable CORS with specific origin
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST'], // Allow specific methods
    allowedHeaders: ['Content-Type', 'Authorization'] // Specify headers if needed
}));

// Cloudinary configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Promisify Cloudinary upload_stream for cleaner async/await usage
const uploadToCloudinary = (fileBuffer, folder, publicId) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                public_id: publicId,
                resource_type: 'image',
                overwrite: true,
                format: 'jpg' // You can adjust the format as needed
            },
            (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            }
        );
        stream.end(fileBuffer);
    });
};

// Set up multer storage engine (in-memory storage)
const storage = multer.memoryStorage();

// File filter to allow only images
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'), false);
    }
};

// Multer middleware with file size limit (e.g., 10MB per file)
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Endpoint 1: Upload both targetImage and swapImage
app.post('/upload', upload.fields([
    { name: 'targetImage', maxCount: 1 },
    { name: 'swapImage', maxCount: 1 }
]), async (req, res) => {
    try {
        // Check if both files are uploaded
        if (!req.files || !req.files['targetImage'] || !req.files['swapImage']) {
            return res.status(400).json({ message: 'Both target image and swap image must be uploaded.' });
        }

        const targetImageFile = req.files['targetImage'][0];
        const swapImageFile = req.files['swapImage'][0];

        // Generate unique public IDs using UUIDs
        const targetPublicId = `target_images/${uuidv4()}`;
        const swapPublicId = `swap_images/${uuidv4()}`;

        // Upload target image to Cloudinary
        const targetResult = await uploadToCloudinary(targetImageFile.buffer, 'target_images', path.parse(targetPublicId).name);
        const targetImageUrl = targetResult.secure_url;

        // Upload swap image to Cloudinary
        const swapResult = await uploadToCloudinary(swapImageFile.buffer, 'swap_images', path.parse(swapPublicId).name);
        const swapImageUrl = swapResult.secure_url;

        // Return both image URLs
        return res.status(200).json({
            message: 'Images uploaded successfully!',
            targetImageUrl,
            swapImageUrl
        });
    } catch (error) {
        console.error('Error uploading images to Cloudinary:', error);
        return res.status(500).json({ message: 'Error uploading images to Cloudinary.' });
    }
});

// Endpoint 2: Upload only swapImage
app.post('/uploadSwap', upload.single('swapImage'), async (req, res) => {
    try {
        // Check if swapImage is uploaded
        if (!req.file) {
            return res.status(400).json({ message: 'Swap image must be uploaded.' });
        }

        const swapImageFile = req.file;

        // Generate unique public ID using UUID
        const swapPublicId = `swap_images/${uuidv4()}`;

        // Upload swap image to Cloudinary
        const swapResult = await uploadToCloudinary(swapImageFile.buffer, 'swap_images', path.parse(swapPublicId).name);
        const swapImageUrl = swapResult.secure_url;

        // Return swap image URL
        return res.status(200).json({
            message: 'Swap image uploaded successfully!',
            swapImageUrl
        });
    } catch (error) {
        console.error('Error uploading swap image to Cloudinary:', error);
        return res.status(500).json({ message: 'Error uploading swap image to Cloudinary.' });
    }
});

// Endpoint 3: Upload result image from URL to Cloudinary
app.post('/uploadResult', express.json(), async (req, res) => {
    try {
        const { resultUrl } = req.body;

        if (!resultUrl) {
            return res.status(400).json({ message: 'Result URL must be provided.' });
        }

        // Fetch the image from the resultUrl
        const response = await fetch(resultUrl);
        if (!response.ok) {
            return res.status(400).json({ message: 'Failed to fetch image from resultUrl.' });
        }

        const buffer = await response.buffer();

        // Generate unique public ID using UUID
        const resultPublicId = `result_images/${uuidv4()}`;

        // Upload the fetched image to Cloudinary
        const resultUpload = await uploadToCloudinary(buffer, 'result_images', path.parse(resultPublicId).name);
        const resultImageUrl = resultUpload.secure_url;

        // Return the new Cloudinary URL
        return res.status(200).json({
            message: 'Result image uploaded successfully!',
            resultImageUrl
        });
    } catch (error) {
        console.error('Error uploading result image to Cloudinary:', error);
        return res.status(500).json({ message: 'Error uploading result image to Cloudinary.' });
    }
});

// Serve static files (e.g., HTML page)
app.use(express.static('public'));

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ message: 'An unexpected error occurred.' });
});

// Start the server
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
