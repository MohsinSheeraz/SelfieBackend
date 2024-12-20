// server.js

import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fetch from 'node-fetch'; // Ensure node-fetch is installed
import sharp from 'sharp';
import axios from 'axios';

// Load environment variables from .env file
dotenv.config();

// Initialize express app
const app = express();

// Enable CORS with specific origin
const allowedOrigins = ['http://localhost:3000', process.env.FRONTEND_URL || 'https://selfie-swap.vercel.app'];
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
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Middleware to parse JSON bodies
app.use(express.json());

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
                format: 'jpg' // Adjust format as needed
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

// Endpoint 1: Upload only swapImage
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

// Endpoint 2: Upload result image from URL to Cloudinary
app.post('/uploadResult', async (req, res) => {
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

// Endpoint 3: Generate mockups using Printful's API
app.post('/generateMockups', async (req, res) => {
    try {
        const { resultImageUrl, products } = req.body; // products: array of product types with base image URLs

        if (!resultImageUrl || !products || !Array.isArray(products)) {
            return res.status(400).json({ message: 'resultImageUrl and products array must be provided.' });
        }

        const mockupPromises = products.map(async (product) => {
            const { id, name, baseImageUrl } = product;

            // Map your product names to Printful's product variants
            // You need to ensure that the product names match Printful's naming conventions
            // For example, "T-Shirt" might correspond to "tshirt" in Printful

            // Example mapping (adjust based on Printful's catalog)
            const printfulProductVariant = {
                "T-Shirt": {
                    variant_id: 4011, // Example variant ID for T-Shirt
                },
                "Mug": {
                    variant_id: 3011, // Example variant ID for Mug
                },
                // Add mappings for other products
            }[name];

            if (!printfulProductVariant) {
                console.error(`No Printful variant mapping defined for product ${name}`);
                return null;
            }

            // Prepare the mockup request
            const mockupData = {
                variant_id: printfulProductVariant.variant_id,
                format: "png",
                image_url: resultImageUrl,
                position: {
                    area_width: 300, // Adjust based on product
                    area_height: 300,
                    area_left: 100,
                    area_top: 150,
                },
            };

            try {
                const response = await axios.post(
                    'https://api.printful.com/mockup-generator/create-task',
                    mockupData,
                    {
                        headers: {
                            'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );

                const taskId = response.data.result.task.id;

                // Polling for task completion (or implement webhooks)
                let mockupImageUrl = null;
                let attempts = 0;
                const maxAttempts = 10;
                const delay = 2000; // 2 seconds

                while (attempts < maxAttempts && !mockupImageUrl) {
                    await new Promise(resolve => setTimeout(resolve, delay));

                    const taskStatusResponse = await axios.get(
                        `https://api.printful.com/mockup-generator/task/${taskId}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                            },
                        }
                    );

                const taskStatus = taskStatusResponse.data.result.task.status;

                if (taskStatus === 'success') {
                    mockupImageUrl = taskStatusResponse.data.result.task.result_url;
                } else if (taskStatus === 'error') {
                    throw new Error(`Mockup generation failed for product ${name}`);
                }

                attempts += 1;
                }

                if (!mockupImageUrl) {
                    throw new Error(`Mockup generation timed out for product ${name}`);
                }

                return {
                    productId: id,
                    productName: name,
                    mockupImageUrl,
                };

            } catch (error) {
                console.error(`Error generating mockup for product ${name}:`, error.message);
                return null;
            }
        });

        const mockupResults = await Promise.all(mockupPromises);
        const successfulMockups = mockupResults.filter(mockup => mockup !== null);

        return res.status(200).json({
            message: 'Mockups generated successfully!',
            mockupUrls: successfulMockups,
        });

    } catch (error) {
        console.error('Error generating mockups:', error);
        return res.status(500).json({ message: 'Error generating mockups.' });
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
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
