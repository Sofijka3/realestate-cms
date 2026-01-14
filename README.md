# RealEstate CMS 🏠

A dynamic content management system for real estate listings.
Developed as a **Diploma Project** using the MERN stack approach (MongoDB, Express, Node.js).

## 🚀 Features
- **Public Interface:** Advanced search & filtering (price, city, district, type), multi-language support (PL, EN, UA).
- **User Dashboard:** Register/Login, manage own listings, "Favorites" functionality.
- **Admin Panel:** User management, content moderation, dynamic dictionary management (cities, categories), CMS for static pages.

## 🛠 Tech Stack
- **Backend:** Node.js, Express.js
- **Database:** MongoDB Atlas (Mongoose ODM)
- **Frontend:** EJS (Templating), CSS3, Vanilla JS
- **Authentication:** Express-Session, BCrypt (Secure password hashing)
- **File Handling:** Multer + Sharp (Image resizing & optimization)

## 📦 How to Run Locally

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Sofijka3/realestate-cms.git](https://github.com/Sofijka3/realestate-cms.git)
   cd realestate-cms
Install dependencies:

Bash

npm install
Database Configuration:

Create a Cluster on MongoDB Atlas.

Update the MONGO_URI in server.js with your connection string.

Insert the initial configuration document into the globalsettings collection.

Run the server:

Bash

node server.js
# Or for development:
npm run dev
The app will run at: http://localhost:10000

🔮 Roadmap (Future Improvements)
Refactoring: Split server.js into separate MVC modules (Routes/Controllers/Models).

Cloud Storage: Integrate AWS S3 or Cloudinary for persistent image storage (currently using ephemeral file system for MVP).

API: Implement REST API endpoints for future mobile app integration.

UX: Implement AJAX-based dependent dropdowns for City -> District selection.