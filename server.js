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
import Stripe from 'stripe';

// Load environment variables from .env file
dotenv.config();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2022-11-15',
});

// Initialize express app
const app = express();

// Enable CORS with specific origin
const allowedOrigins = [
    'http://localhost:3000',
    process.env.FRONTEND_URL || 'https://selfie-swap.vercel.app'
];
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
        return res.status(500).json({ message: 'Error uploading images to Cloudinary.', error: error.message });
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
        return res.status(500).json({ message: 'Error uploading swap image to Cloudinary.', error: error.message });
    }
});

// Endpoint 3: Upload result image from URL to Cloudinary
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
        return res.status(500).json({ message: 'Error uploading result image to Cloudinary.', error: error.message });
    }
});

// Endpoint 4: Generate mockups by overlaying swapped image onto product images
app.post('/generateMockups', async (req, res) => {
    try {
        const { resultImageUrl, products } = req.body; // products is an array of product types with base image URLs

        if (!resultImageUrl || !products || !Array.isArray(products)) {
            return res.status(400).json({ message: 'resultImageUrl and products array must be provided.' });
        }

        // Define overlay positions and sizes based on product name
        const overlayConfig = {
            "T-Shirt": { x: 100, y: 150, width: 300, height: 300 },
            "Mug": { x: 50, y: 50, width: 200, height: 200 },
            "Phone Case": { x: 80, y: 100, width: 240, height: 240 },
            "Poster": { x: 150, y: 200, width: 500, height: 500 },
            "Hoodie": { x: 100, y: 150, width: 300, height: 300 },
            "Tote Bag": { x: 80, y: 100, width: 240, height: 240 },
            // Add more product types as needed
        };

        // Fetch the swapped image buffer
        const swappedImageResponse = await fetch(resultImageUrl);
        if (!swappedImageResponse.ok) {
            return res.status(400).json({ message: 'Failed to fetch swapped image.' });
        }
        const swappedImageBuffer = await swappedImageResponse.buffer();

        // Initialize an array to hold mockup URLs
        const mockupUrls = [];

        for (const product of products) {
            const { id, name, baseImageUrl } = product;

            // Get overlay config for the product
            const config = overlayConfig[name];
            if (!config) {
                console.error(`No overlay config defined for product ${name}`);
                continue; // Skip this product
            }

            const { x, y, width, height } = config;

            // Fetch the base product image
            const baseImageResponse = await fetch(baseImageUrl);
            if (!baseImageResponse.ok) {
                console.error(`Failed to fetch base image for product ${name}`);
                continue; // Skip this product
            }
            const baseImageBuffer = await baseImageResponse.buffer();

            // Resize the swapped image to fit the overlay size
            const resizedSwappedImage = await sharp(swappedImageBuffer)
                .resize(width, height)
                .toBuffer();

            // Composite the swapped image onto the base image
            const compositeImage = await sharp(baseImageBuffer)
                .composite([{
                    input: resizedSwappedImage,
                    top: y,
                    left: x
                }])
                .toBuffer();

            // Upload the composite image to Cloudinary
            const mockupPublicId = `mockups/${uuidv4()}`;
            const uploadResult = await uploadToCloudinary(compositeImage, 'mockups', path.parse(mockupPublicId).name);

            const mockupImageUrl = uploadResult.secure_url;
            mockupUrls.push({
                productId: id,
                productName: name,
                mockupImageUrl
            });
        }

        return res.status(200).json({
            message: 'Mockups generated successfully!',
            mockupUrls
        });

    } catch (error) {
        console.error('Error generating mockups:', error);
        return res.status(500).json({ message: 'Error generating mockups.', error: error.message });
    }
});

// Endpoint 5: Fetch Printful products
app.get('/fetchPrintfulProducts', async (req, res) => {
    try {
        console.log("Received GET request to /fetchPrintfulProducts");
        const response = await fetch('https://api.printful.com/products', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.log('Error fetching Printful products:', response.statusText);
            return res.status(response.status).json({ message: 'Error fetching Printful products.' });
        }

        const data = await response.json();
        const products = data.result;

        // Select 5-6 products, e.g., the first 6
        const selectedProducts = products.slice(0, 6).map(product => ({
            id: product.id,
            name: product.title,
            image: product.image // assuming image URL is in product.image
        }));

        console.log("Selected Printful products:", selectedProducts);

        return res.status(200).json({
            message: 'Printful products fetched successfully!',
            products: selectedProducts
        });
    } catch (error) {
        console.error('Error in /fetchPrintfulProducts:', error);
        return res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
});

// Endpoint 6: Create a Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { cartItems } = req.body;

        if (!cartItems || !Array.isArray(cartItems)) {
            return res.status(400).json({ message: 'Cart items must be provided.' });
        }

        // Validate cart items
        const validatedItems = cartItems.filter(item =>
            item.id && item.name && item.image && item.price && item.quantity
        );

        if (validatedItems.length === 0) {
            return res.status(400).json({ message: 'No valid cart items provided.' });
        }

        // Further validation: ensure types and positive quantities
        const isValid = validatedItems.every(item =>
            typeof item.id === 'number' &&
            typeof item.name === 'string' &&
            typeof item.image === 'string' &&
            typeof item.price === 'number' &&
            typeof item.quantity === 'number' &&
            item.quantity > 0
        );

        if (!isValid) {
            return res.status(400).json({ message: 'Invalid cart item data.' });
        }

        // Map cart items to Stripe line items
        const lineItems = validatedItems.map(item => ({
            price_data: {
                currency: 'usd',
                product_data: {
                    name: item.name,
                    images: [item.image],
                },
                unit_amount: Math.round(item.price * 100), // Stripe expects amount in cents
            },
            quantity: item.quantity,
        }));

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/checkout`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating Stripe Checkout Session:', error);
        res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
});

// Endpoint 7: Retrieve Stripe Checkout Session
app.get('/checkout-session', async (req, res) => {
    try {
        const { session_id } = req.query;

        if (!session_id) {
            return res.status(400).json({ message: 'Session ID is required.' });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id.toString());

        res.json(session);
    } catch (error) {
        console.error('Error retrieving Stripe Checkout Session:', error);
        res.status(500).json({ message: 'Internal server error.', error: error.message });
    }
});

// Serve static files (e.g., HTML page)
app.use(express.static('public'));

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ message: 'An unexpected error occurred.', error: err.message });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
