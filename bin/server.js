#!/usr/bin/env node

const { PluginServer } = require('../dist/PluginServer');
const { LocalTestServer } = require('../dist/LocalTestServer');
const path = require('path');
const fs = require('fs');

/**
 * Plugin Server Entry Point
 * Khởi động server để chạy plugins phân tán
 */
async function startPluginServer() {
  try {
    console.log('🚀 Starting LeanEZ Plugin Server...');
    
    // Load manifest từ thư mục hiện tại
    const currentDir = process.cwd();
    const manifestPath = path.join(currentDir, 'manifest.json');
    
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      manifest = JSON.parse(manifestContent);
    } else {
      throw new Error('manifest.json not found in current directory. Please run this command in your plugin directory.');
    }
    
    // Lấy config từ environment variables hoặc manifest
    const isProduction = process.env.NODE_ENV === 'production';
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    const config = {
      server_id: `node:${manifest.id}`,
      queue_name: process.env.PLUGIN_QUEUE_NAME || 'plugin-execution',
      enable_local_testing: isDevelopment,
      port: parseInt(process.env.PORT || '8080'),
      plugins_path: currentDir, // Thư mục hiện tại
      leanez_base_url: process.env.LEANEZ_BASE_URL || (isProduction ? 'https://api.leanez.app' : 'http://localhost:3000'),
      leanez_api_key: process.env.API_KEY,
      log_level: process.env.LOG_LEVEL || 'info'
    };

    console.log('📋 Server Configuration:');
    console.log(`   Server ID: ${config.server_id}`);
    console.log(`   Queue Name: ${config.queue_name}`);
    console.log(`   Plugin Directory: ${config.plugins_path}`);
    console.log(`   LeanEZ URL: ${config.leanez_base_url}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Local Testing: ${config.enable_local_testing ? 'Enabled' : 'Disabled'}`);
    if (config.enable_local_testing) {
      console.log(`   Port: ${config.port}`);
    }
    console.log(`   Plugin: ${manifest.name} v${manifest.version}`);

    // Tạo Plugin Server
    const pluginServer = new PluginServer(config);
    
    // Tạo Local Test Server nếu được bật
    let testServer = null;
    if (config.enable_local_testing) {
      testServer = new LocalTestServer(pluginServer, config.port);
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down gracefully...');
      
      try {
        if (testServer) {
          await testServer.stop();
        }
        await pluginServer.stop();
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down...');
      
      try {
        if (testServer) {
          await testServer.stop();
        }
        await pluginServer.stop();
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    });

    // Start servers
    await pluginServer.start();
    
    if (testServer) {
      await testServer.start();
    }

    console.log('🎉 Plugin Server is running!');
    console.log('   Press Ctrl+C to stop');
    
    // Keep process alive
    process.stdin.resume();
    
  } catch (error) {
    console.error('❌ Failed to start Plugin Server:', error.message);
    process.exit(1);
  }
}

// Start server
startPluginServer(); 