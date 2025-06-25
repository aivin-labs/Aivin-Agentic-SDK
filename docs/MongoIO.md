# 🗄️ MongoIO - MongoDB Connection Manager

**MongoIO** là MongoDB connection manager giúp cung cấp truy cập đến native Mongoose API cho LeanEZ plugins.

**Lưu ý**: MongoIO chỉ khả dụng nếu bạn đã chọn **MongoDB** stack khi tạo plugin.

## 🚀 Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| **Tự động kết nối** | Xử lý kết nối MongoDB tự động |
| **Native Mongoose API** | Truy cập đầy đủ Mongoose API |
| **Zero Learning Curve** | Không cần học thêm, sử dụng Mongoose như bình thường |
| **TypeScript Support** | Hỗ trợ đầy đủ TypeScript với type definitions |

## 🏃 Quick Start

### Tạo Schema và Model
```javascript
import { MongoIO } from '@leanez/sdk';

// Tạo schema
const userSchema = new MongoIO.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  age: { type: Number, min: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Tạo model
const User = MongoIO.model('User', userSchema);
```

### Các thao tác cơ bản với Mongoose
```javascript
// Tạo user mới
const newUser = new User({
  name: 'John Doe',
  email: 'john@example.com',
  age: 30
});
await newUser.save();

// Tìm users
const users = await User.find({ age: { $gte: 18 } });
const user = await User.findOne({ email: 'john@example.com' });

// Cập nhật
await User.updateOne(
  { email: 'john@example.com' },
  { $set: { age: 31 } }
);

// Xóa
await User.deleteOne({ email: 'john@example.com' });
```

## 📖 API Reference

### Connection Management

#### `MongoIO.isReady()`
Kiểm tra trạng thái kết nối

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

##### Return Value
| Type | Description |
|------|-------------|
| `boolean` | `true` nếu kết nối đã sẵn sàng |

##### Example
```javascript
if (MongoIO.isReady()) {
  console.log('MongoDB connection is ready!');
} else {
  console.log('MongoDB connection not ready yet...');
}
```

---

#### `MongoIO.healthCheck()`
Kiểm tra sức khỏe kết nối

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<HealthStatus>` | Thông tin sức khỏe kết nối |

##### Example
```javascript
const health = await MongoIO.healthCheck();
console.log(health);
// Output: { status: 'connected', latency: 15, dbName: 'myapp' }
```

---

#### `MongoIO.disconnect()`
Đóng kết nối MongoDB

##### Input Parameters
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| *Không có parameters* | - | - | - | - |

##### Return Value
| Type | Description |
|------|-------------|
| `Promise<void>` | Promise hoàn thành khi đóng kết nối |

##### Example
```javascript
// Đóng kết nối khi shutdown
await MongoIO.disconnect();
console.log('MongoDB connection closed');
```

## 🔧 Native Mongoose Usage

### Schema với các tính năng nâng cao
```javascript
import { MongoIO } from '@leanez/sdk';

const productSchema = new MongoIO.Schema({
  name: { 
    type: String, 
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  price: { 
    type: Number, 
    required: true,
    min: [0, 'Price cannot be negative'],
    get: v => Math.round(v * 100) / 100 // Round to 2 decimal places
  },
  category: {
    type: String,
    enum: ['electronics', 'clothing', 'books', 'home'],
    required: true
  },
  tags: [String],
  inStock: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Pre-save middleware
productSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Virtual field
productSchema.virtual('displayPrice').get(function() {
  return `$${this.price.toFixed(2)}`;
});

// Instance method
productSchema.methods.toggleStock = function() {
  this.inStock = !this.inStock;
  return this.save();
};

// Static method
productSchema.statics.findByCategory = function(category) {
  return this.find({ category, inStock: true });
};

const Product = MongoIO.model('Product', productSchema);
```

### Sử dụng với Virtuals, Methods và Statics
```javascript
// Tạo product mới
const product = new Product({
  name: 'iPhone 15',
  price: 999.99,
  category: 'electronics',
  tags: ['smartphone', 'apple', 'ios']
});

await product.save();

// Sử dụng virtual
console.log(product.displayPrice); // "$999.99"

// Sử dụng instance method
await product.toggleStock();

// Sử dụng static method
const electronics = await Product.findByCategory('electronics');
```

## 🌍 Environment Variables

Khi chọn MongoDB stack, các biến môi trường sau sẽ được tự động cấu hình:

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGO_URL` | MongoDB connection string | `mongodb://localhost:27017` |
| `MONGO_DB` | Database name | `leanez_app` |

## 💡 Ví dụ thực tế

### E-commerce Product Management
```javascript
import { MongoIO } from '@leanez/sdk';

// Product schema
const productSchema = new MongoIO.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  inventory: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Product = MongoIO.model('Product', productSchema);

// Plugin function
export default async function manageProducts(action, data) {
  try {
    switch (action) {
      case 'create':
        const newProduct = new Product(data);
        await newProduct.save();
        return { success: true, product: newProduct };
        
      case 'list':
        const products = await Product.find()
          .sort({ createdAt: -1 })
          .limit(data.limit || 10);
        return { success: true, products };
        
      case 'update':
        const updated = await Product.findByIdAndUpdate(
          data.id,
          data.updates,
          { new: true, runValidators: true }
        );
        return { success: true, product: updated };
        
      case 'delete':
        await Product.findByIdAndDelete(data.id);
        return { success: true, message: 'Product deleted' };
        
      default:
        throw new Error('Invalid action');
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

### User Analytics với Aggregation
```javascript
import { MongoIO } from '@leanez/sdk';

const userSchema = new MongoIO.Schema({
  name: String,
  email: String,
  registeredAt: { type: Date, default: Date.now },
  lastLogin: Date,
  purchases: [{
    productId: MongoIO.Schema.Types.ObjectId,
    amount: Number,
    date: { type: Date, default: Date.now }
  }]
});

const User = MongoIO.model('User', userSchema);

// Analytics function
export default async function getUserAnalytics() {
  try {
    const analytics = await User.aggregate([
      // Match active users (logged in last 30 days)
    {
      $match: {
          lastLogin: { 
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) 
          }
        }
      },
      // Add computed fields
      {
        $addFields: {
          totalPurchases: { $size: '$purchases' },
          totalSpent: { $sum: '$purchases.amount' }
        }
      },
      // Group by month
    {
      $group: {
        _id: {
            year: { $year: '$registeredAt' },
            month: { $month: '$registeredAt' }
          },
          userCount: { $sum: 1 },
          avgSpent: { $avg: '$totalSpent' },
          totalRevenue: { $sum: '$totalSpent' }
        }
      },
      // Sort by date
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);

    return { success: true, analytics };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

## ⚡ Performance Tips

| Tip | Description |
|-----|-------------|
| **Indexing** | Tạo index cho các fields thường query |
| **Lean Queries** | Sử dụng `.lean()` cho read-only operations |
| **Projection** | Chỉ select fields cần thiết |
| **Pagination** | Sử dụng `limit()` và `skip()` cho large datasets |
| **Connection Pooling** | Cấu hình `maxPoolSize` phù hợp |

### Example với Performance Optimization
```javascript
// Index creation
productSchema.index({ category: 1, price: -1 });
productSchema.index({ name: 'text' });

// Optimized queries
const products = await Product
  .find({ category: 'electronics' })
  .select('name price category') // Projection
  .lean() // Faster read-only
  .limit(20) // Pagination
  .sort({ price: -1 }); // Use index
```

## 🎯 Best Practices

| Practice | Description |
|----------|-------------|
| **Schema Design** | Thiết kế schema phù hợp với use case |
| **Validation** | Sử dụng schema validation thay vì application validation |
| **Error Handling** | Xử lý MongoDB errors properly |
| **Connection Management** | Kiểm tra connection status trước khi query |
| **Data Modeling** | Embed vs Reference dựa trên access patterns | 