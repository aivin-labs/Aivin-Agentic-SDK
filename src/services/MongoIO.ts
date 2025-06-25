import mongoose from 'mongoose';

/**
 * MongoIO - MongoDB connection manager
 * Handles connection initialization and exposes native Mongoose API
 */
export class MongoIO {
  private static isConnected = false;
  private static connectionUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
  private static databaseName = process.env.MONGO_DB || 'leanez_plugins';

  /**
   * Initialize MongoDB connection
   */
  static async init(): Promise<void> {
    if (this.isConnected) return;

    try {
      const options = {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxIdleTimeMS: 30000,
        retryWrites: true,
        bufferCommands: false
      };

      const fullUrl = `${this.connectionUrl}/${this.databaseName}`;
      await mongoose.connect(fullUrl, options);
      
      this.isConnected = true;
      console.log(`[MongoIO] Connected to ${fullUrl}`);
    } catch (error: any) {
      console.error(`[MongoIO] Connection failed:`, error);
      throw new Error(`MongoDB connection failed: ${error.message}`);
    }
  }

  /**
   * Configure connection settings
   */
  static configure(mongoUrl?: string, dbName?: string): void {
    if (mongoUrl) this.connectionUrl = mongoUrl;
    if (dbName) this.databaseName = dbName;
    console.log(`[MongoIO] Configured: ${this.connectionUrl}/${this.databaseName}`);
  }

  /**
   * Disconnect from MongoDB
   */
  static async disconnect(): Promise<void> {
    if (this.isConnected) {
      await mongoose.disconnect();
      this.isConnected = false;
      console.log(`[MongoIO] Disconnected`);
    }
  }

  /**
   * Check if MongoDB is ready
   */
  static isReady(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  /**
   * Health check
   */
  static async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected) return false;
      await mongoose.connection.db?.admin().ping();
      return true;
    } catch (error) {
      console.error(`[MongoIO] Health check failed:`, error);
      return false;
    }
  }

  // ========================================
  // Expose native Mongoose API directly
  // ========================================

  /**
   * Native Mongoose Schema constructor
   */
  static get Schema() {
    return mongoose.Schema;
  }

  /**
   * Native Mongoose connection
   */
  static get connection() {
    return mongoose.connection;
  }

  /**
   * Native Mongoose Types
   */
  static get Types() {
    return mongoose.Types;
  }

  /**
   * Native Mongoose connect method (use init() instead)
   */
  static get connect() {
    return mongoose.connect.bind(mongoose);
  }

  /**
   * Get mongoose instance directly
   */
  static get mongoose() {
    return mongoose;
  }

  /**
   * Native Mongoose model method
   */
  static model = mongoose.model.bind(mongoose);
} 