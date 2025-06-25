"use strict";
/**
 * Plugin SDK Type Definitions
 *
 * This file contains all type definitions for the Plugin SDK.
 * Can be extracted into a separate npm package later.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_QUEUE_PREFIX = exports.DEFAULT_RETRY_COUNT = exports.DEFAULT_TIMEOUT = exports.SDK_VERSION = exports.PluginLoadError = exports.PluginNotFoundError = exports.PluginTimeoutError = exports.PluginExecutionError = void 0;
// Error Types
class PluginExecutionError extends Error {
    constructor(message, plugin_id, function_name, original_error) {
        super(message);
        this.plugin_id = plugin_id;
        this.function_name = function_name;
        this.original_error = original_error;
        this.name = 'PluginExecutionError';
    }
}
exports.PluginExecutionError = PluginExecutionError;
class PluginTimeoutError extends Error {
    constructor(timeout) {
        super(`Plugin execution timed out after ${timeout}ms`);
        this.name = 'PluginTimeoutError';
        this.timeout = timeout;
    }
}
exports.PluginTimeoutError = PluginTimeoutError;
class PluginNotFoundError extends Error {
    constructor(pluginId) {
        super(`Plugin not found: ${pluginId}`);
        this.name = 'PluginNotFoundError';
    }
}
exports.PluginNotFoundError = PluginNotFoundError;
class PluginLoadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PluginLoadError';
    }
}
exports.PluginLoadError = PluginLoadError;
// Constants
exports.SDK_VERSION = '1.0.0';
exports.DEFAULT_TIMEOUT = 30000; // 30 seconds
exports.DEFAULT_RETRY_COUNT = 3;
exports.DEFAULT_QUEUE_PREFIX = 'plugin';
//# sourceMappingURL=PluginTypes.js.map