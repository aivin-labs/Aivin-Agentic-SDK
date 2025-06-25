#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES6 equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('leanez')
  .description('LeanEZ Plugin SDK - Build and run AI plugins')
  .version('1.0.0');

// Stack configurations
const DEFAULT_STACKS = [
  {
    name: 'AI_LLM',
    description: 'Large Language Models and AI capabilities',
    dependencies: [],
    envVars: [],
    dockerServices: [],
    imports: ['LLMIO']
  },
  {
    name: 'REALTIME_COMMUNICATION',
    description: 'Real-time messaging and notifications',
    dependencies: ['redis'],
    envVars: ['REDIS_URL'],
    dockerServices: ['redis'],
    imports: ['PubSubIO'],
    requires: ['REDIS_CACHE']
  }
];

const OPTIONAL_STACKS = [
  {
    name: 'REDIS_CACHE',
    description: 'In-memory caching and session storage',
    dependencies: ['redis'],
    envVars: ['REDIS_URL'],
    dockerServices: ['redis'],
    imports: ['RedisIO']
  },
  {
    name: 'MONGODB',
    description: 'NoSQL database for document storage',
    dependencies: ['mongoose'],
    envVars: ['MONGO_URL', 'MONGO_DB'],
    dockerServices: ['mongodb'],
    imports: ['MongoIO']
  },
  {
    name: 'BACKGROUND_JOBS',
    description: 'Queue system for background processing',
    dependencies: ['bull', 'redis'],
    envVars: ['REDIS_URL'],
    dockerServices: ['redis'],
    imports: ['BullIO'],
    requires: ['REDIS_CACHE']
  }
];

// Combined stacks for compatibility
const AVAILABLE_STACKS = [...DEFAULT_STACKS, ...OPTIONAL_STACKS];

// Helper function to get package version
function getPackageVersion(packageName) {
  // Use latest for all packages to avoid version conflicts
  return 'latest';
}

// Helper functions
function generateRandomPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Helper function to resolve stack dependencies
function resolveStackDependencies(selectedStacks) {
  const resolved = new Set(selectedStacks.map(s => s.name));
  const allStacks = [...selectedStacks];
  
  // Auto-resolve required stacks
  selectedStacks.forEach(stack => {
    if (stack.requires) {
      stack.requires.forEach(requiredStackName => {
        if (!resolved.has(requiredStackName)) {
          const requiredStack = AVAILABLE_STACKS.find(s => s.name === requiredStackName);
          if (requiredStack) {
            resolved.add(requiredStackName);
            allStacks.push(requiredStack);
            console.log(chalk.yellow(`📦 Auto-including ${requiredStackName} (required by ${stack.name})`));
          }
        }
      });
    }
  });
  
  return allStacks;
}

// Command: create plugin with stack selection
program
  .command('create')
  .description('Create new plugin')
  .option('--json <config>', 'JSON config (AI mode)')
  .option('--stdin', 'Read from stdin')
  .option('--name <name>', 'Plugin name (if not specified, will prompt)')
  .option('--silent', 'Silent mode')
  .option('--json-output', 'JSON output')
  .action(async (options) => {
    try {
      let result;
      
      if (options.stdin) {
        const stdinData = await readStdin();
        result = await createFromJSON(stdinData, options);
      } else if (options.json) {
        result = await createFromJSON(options.json, options);
      } else {
        result = await createInteractive(options);
      }

      if (options.jsonOutput && result) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      if (options.jsonOutput) {
        console.log(JSON.stringify({
          success: false,
          error: error.message,
          code: error.code || 'ERROR'
        }, null, 2));
      } else if (!options.silent) {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Helper function to read from stdin
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

// AI-friendly JSON mode
async function createFromJSON(jsonConfig, options) {
  try {
    let config;
    
    if (typeof jsonConfig === 'string') {
      try {
        config = JSON.parse(jsonConfig);
      } catch (parseError) {
        if (fs.existsSync(jsonConfig)) {
          config = JSON.parse(fs.readFileSync(jsonConfig, 'utf8'));
        } else {
          throw new Error('Invalid JSON: ' + parseError.message);
        }
      }
    } else {
      config = jsonConfig;
    }

    const validationResult = validatePluginConfig(config);
    if (!validationResult.valid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Always include default stacks, then add any specified additional stacks
    const configuredStacks = config.stacks.map(stackName => {
      const stack = AVAILABLE_STACKS.find(s => s.name === stackName);
      if (!stack) {
        throw new Error(`Unknown stack: ${stackName}`);
      }
      return stack;
    });

    // Combine default stacks with configured stacks (avoid duplicates)
    const selectedStacks = [...DEFAULT_STACKS, ...configuredStacks.filter(stack => 
      !DEFAULT_STACKS.some(defaultStack => defaultStack.name === stack.name)
    )];

    const resolvedStacks = resolveStackDependencies(selectedStacks);

    const pluginDir = path.join(process.cwd(), options.outputDir || '', config.name);

    if (fs.existsSync(pluginDir) && !config.overwrite) {
      throw new Error(`Directory exists: ${pluginDir}`);
    }

    if (!options.silent) {
      console.log(chalk.blue('🤖 Creating plugin:'), config.name);
      console.log(chalk.cyan('📦 Including default stacks: AI_LLM, REALTIME_COMMUNICATION'));
      if (config.stacks.length > 0) {
        console.log(chalk.blue('📦 Additional stacks:'), config.stacks.join(', '));
      }
    }

    await createPluginProject(pluginDir, config.name, config.description || 'AI plugin', resolvedStacks, config);

    if (!options.silent) {
      console.log(chalk.green('✅ Created:'), pluginDir);
    }

    return {
      success: true,
      pluginDir,
      name: config.name,
      description: config.description,
      stacks: selectedStacks.map(s => s.name),
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    if (!options.silent) {
      console.error(chalk.red('❌'), error.message);
    }
    throw error;
  }
}

// Enhanced config validation
function validatePluginConfig(config) {
  const errors = [];
  
  if (!config.name) {
    errors.push('Missing name');
  } else if (!/^[a-z0-9-]+$/.test(config.name)) {
    errors.push('Invalid name format');
  }
  
  // Allow empty stacks array since default stacks will be added automatically
  if (config.stacks && !Array.isArray(config.stacks)) {
    errors.push('Stacks must be array');
  }
  
  // Set default empty array if stacks not provided
  if (!config.stacks) {
    config.stacks = [];
  }
  
  if (config.functions && !Array.isArray(config.functions)) {
    errors.push('Functions must be array');
  }
  
  if (config.functions) {
    config.functions.forEach((func, index) => {
      if (!func.name) errors.push(`Function ${index}: missing name`);
      if (!func.inputs) errors.push(`Function ${func.name || index}: missing inputs`);
      if (!func.outputs) errors.push(`Function ${func.name || index}: missing outputs`);
    });
  }
  
  return { valid: errors.length === 0, errors };
}

// Command: Validate plugin config
program
  .command('validate')
  .description('Validate JSON config')
  .option('--json <config>', 'JSON config')
  .option('--stdin', 'From stdin')
  .option('--json-output', 'JSON output')
  .action(async (options) => {
    try {
      let configData;
      
      if (options.stdin) {
        configData = await readStdin();
      } else if (options.json) {
        configData = options.json;
      } else {
        throw new Error('Need --json or --stdin');
      }
      
      const config = JSON.parse(configData);
      const result = validatePluginConfig(config);
      
      if (options.jsonOutput) {
        console.log(JSON.stringify({
          valid: result.valid,
          errors: result.errors
        }, null, 2));
      } else {
        if (result.valid) {
          console.log(chalk.green('✅ Valid'));
        } else {
          console.log(chalk.red('❌ Invalid:'));
          result.errors.forEach(error => console.log(`  • ${error}`));
        }
      }
      
      if (!result.valid) process.exit(1);
    } catch (error) {
      if (options.jsonOutput) {
        console.log(JSON.stringify({ valid: false, error: error.message }, null, 2));
      } else {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Interactive mode (existing functionality)
async function createInteractive(options) {
  console.log(chalk.blue('🚀 LeanEZ Plugin Creator\n'));

  const pluginDir = process.cwd();
  let pluginName = options.name;

  // Check if package.json exists to get plugin name
  let currentPackageJson = null;
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    currentPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    pluginName = pluginName || currentPackageJson.name?.replace('@leanez/plugin-', '') || path.basename(process.cwd());
  } else {
    pluginName = pluginName || path.basename(process.cwd());
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Plugin name:',
      default: pluginName,
      validate: (input) => {
        if (!input.trim()) return 'Plugin name cannot be empty';
        if (!/^[a-z0-9-]+$/.test(input)) return 'Plugin name must contain only lowercase letters, numbers, and hyphens';
        return true;
      }
    },
    {
      type: 'input',
      name: 'description',
      message: 'Plugin description:',
      default: currentPackageJson?.description || 'New LeanEZ plugin'
    },
    {
      type: 'checkbox',
      name: 'optionalStacks',
      message: 'Select additional stacks (AI_LLM & REALTIME_COMMUNICATION are included by default):',
      choices: OPTIONAL_STACKS.map(stack => ({
        name: `${stack.name} - ${stack.description}`,
        value: stack,
        checked: false
      })),
      validate: () => true // Optional stacks, so no validation needed
    }
  ]);

  pluginName = answers.name;
  
  // Combine default stacks with selected optional stacks
  const selectedStacks = [...DEFAULT_STACKS, ...answers.optionalStacks];
  
  // Show which stacks are included
  console.log(chalk.cyan('\n📦 Included stacks:'));
  console.log(chalk.green('   • AI_LLM (default)'));
  console.log(chalk.green('   • REALTIME_COMMUNICATION (default)'));
  answers.optionalStacks.forEach(stack => {
    console.log(chalk.blue(`   • ${stack.name}`));
  });
  
  // Resolve stack dependencies
  const resolvedStacks = resolveStackDependencies(selectedStacks);
  
  await createPluginProject(pluginDir, pluginName, answers.description, resolvedStacks, null, currentPackageJson);
  console.log(chalk.green(`\n✅ Plugin files created successfully!`));
  console.log(`📁 Directory: ${pluginDir}`);
  console.log(chalk.cyan(`\n🔧 Next steps:`));
  if (resolvedStacks.some(s => s.dockerServices.length > 0)) {
    console.log(`   npm install  # Install dependencies`);
    console.log(`   npm start    # Start plugin (Docker will auto-start)`);
  } else {
    console.log(`   npm install  # Install dependencies`);
    console.log(`   npm start    # Start plugin`);
  }
}

async function createPluginProject(pluginDir, name, description, stacks, aiConfig = null, currentPackageJson = null) {
  // Create directory
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  // Create data directory for persistence
  const dataDir = path.join(pluginDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Create files
  await Promise.all([
    createManifest(pluginDir, name, description, aiConfig),
    createHandler(pluginDir, stacks, aiConfig),
    createPackageJson(pluginDir, name, description, stacks, currentPackageJson),
    createDockerCompose(pluginDir, stacks),
    createEnv(pluginDir, stacks)
  ]);
}

async function createManifest(pluginDir, name, description, aiConfig) {
  // AI-generated functions if provided
  let functions = [
    {
      name: 'main',
      triggers: ['manual', 'api', 'chat'],
      description: 'Main plugin function',
      inputs: [
        {
          field: 'data',
          required: false,
          description: 'Input data for processing',
          type: 'object'
        },
        {
          field: 'options',
          required: false,
          description: 'Processing options',
          type: 'object',
          default: {}
        }
      ],
      outputs: [
        {
          field: 'success',
          description: 'Operation success status',
          type: 'boolean'
        },
        {
          field: 'data',
          description: 'Processed data result',
          type: 'object'
        },
        {
          field: 'message',
          description: 'Result message',
          type: 'string'
        }
      ]
    }
  ];

  if (aiConfig && aiConfig.functions) {
    functions = aiConfig.functions;
  }

  const manifest = {
    name,
    version: '1.0.0',
    description,
    functions
  };

  // Only add author if provided
  if (aiConfig?.author) {
    manifest.author = aiConfig.author;
  }

  // Only add email if provided
  if (aiConfig?.email) {
    manifest.email = aiConfig.email;
  }

  // Add agent configuration
  manifest.agent_specialized = aiConfig?.agent_specialized || [];
  manifest.agent_designated = aiConfig?.agent_designated || [];

  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

async function createHandler(pluginDir, stacks, aiConfig) {
  const imports = [...new Set(stacks.flatMap(s => s.imports))];
  const importStatement = imports.length > 0 
    ? `import { ${imports.join(', ')} } from '@leanez/sdk';`
    : "// import { LLMIO } from '@leanez/sdk';";

  let handlerContent;

  if (aiConfig && aiConfig.handlerCode) {
    // AI-generated complete handler code
    handlerContent = `${importStatement}

${aiConfig.handlerCode}
`;
  } else if (aiConfig && aiConfig.functions) {
    // Generate handler based on AI-defined functions
    const functionImplementations = aiConfig.functions.map(func => {
      const inputParams = Object.keys(func.inputs || {}).join(', ');
      return `export async function ${func.name}(input) {
  try {
    const { ${inputParams} } = input;
    
    // TODO: Implement ${func.description}
    console.log('Function ${func.name} called with:', input);
    
    return {
      success: true,
      data: { 
        processed: true,
        timestamp: new Date().toISOString()
      },
      message: '${func.description} completed successfully'
    };
  } catch (error) {
    console.error('${func.name} error:', error);
    return {
      success: false,
      data: null,
      message: error.message
    };
  }
}`;
    }).join('\n\n');

    handlerContent = `${importStatement}

${functionImplementations}
`;
  } else {
    // Default template with main function
    handlerContent = `${importStatement}

export async function main(input) {
  try {
    const { data, options = {} } = input;
    
    console.log('Plugin main function called with:', { data, options });
    
    // TODO: Implement your main plugin logic here
    // Available stacks: ${stacks.map(s => s.name).join(', ')}
    
    return {
      success: true,
      data: { 
        processed: data,
        timestamp: new Date().toISOString(),
        stacks: '${stacks.map(s => s.name).join(', ')}'
      },
      message: 'Plugin executed successfully!'
    };
  } catch (error) {
    console.error('Plugin error:', error);
    return {
      success: false,
      data: null,
      message: error.message
    };
  }
}
`;
  }

  fs.writeFileSync(path.join(pluginDir, 'handler.js'), handlerContent);
}

async function createPackageJson(pluginDir, name, description, stacks, currentPackageJson = null) {
  const dependencies = [...new Set(stacks.flatMap(s => s.dependencies))];
  const newDeps = {
    '@leanez/sdk': 'latest',
    'dotenv': getPackageVersion('dotenv')
  };
  
  dependencies.forEach(dep => {
    newDeps[dep] = getPackageVersion(dep);
  });

  const newPackageJson = {
    name: `@leanez/plugin-${name}`,
    version: '1.0.0',
    description,
    main: 'handler.js',
    type: 'module',
    scripts: {
      start: 'docker-compose up -d && leanez start',
      test: 'echo "No tests specified"',
      'docker:down': 'docker-compose down',
      'docker:logs': 'docker-compose logs -f',
      clean: 'rm -rf node_modules package-lock.json && npm install'
    },
    dependencies: newDeps,
    devDependencies: {
      '@types/node': '^20.10.0'
    },
    keywords: ['leanez', 'plugin', ...stacks.map(s => s.name.toLowerCase())],
    engines: { node: '>=16.0.0' }
  };

  // Merge with existing package.json if exists
  if (currentPackageJson) {
    const merged = { ...currentPackageJson, ...newPackageJson };
    merged.scripts = { ...newPackageJson.scripts, ...currentPackageJson.scripts };
    merged.dependencies = { ...currentPackageJson.dependencies, ...newDeps };
    merged.devDependencies = { ...newPackageJson.devDependencies, ...currentPackageJson.devDependencies };
    merged.keywords = [...new Set([...(currentPackageJson.keywords || []), ...newPackageJson.keywords])];
    
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(merged, null, 2));
  } else {
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(newPackageJson, null, 2));
  }
}

async function createDockerCompose(pluginDir, stacks) {
  const services = {};
  const selectedServices = [...new Set(stacks.flatMap(s => s.dockerServices))];

  if (selectedServices.includes('redis')) {
    services.redis = {
      image: 'redis:7-alpine',
      ports: ['6379:6379'],
      volumes: ['./data/redis:/data'],
      restart: 'unless-stopped'
    };
  }

  if (selectedServices.includes('mongodb')) {
    const mongoPassword = generateRandomPassword();
    services.mongodb = {
      image: 'mongo:7',
      ports: ['27017:27017'],
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'admin',
        MONGO_INITDB_ROOT_PASSWORD: mongoPassword,
        MONGO_INITDB_DATABASE: 'leanez_plugins'
      },
      volumes: ['./data/mongodb:/data/db'],
      restart: 'unless-stopped'
    };
  }

  if (Object.keys(services).length > 0) {
    let yamlContent = `# Docker Compose for plugin: ${stacks.map(s => s.name).join(', ')}
# Data is persisted in ./data/ directory

version: '3.8'

services:
`;

    // Generate Redis service
    if (services.redis) {
      yamlContent += `  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - ./data/redis:/data
    restart: unless-stopped
`;
    }

    // Generate MongoDB service
    if (services.mongodb) {
      yamlContent += `  mongodb:
    image: mongo:7
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: ${services.mongodb.environment.MONGO_INITDB_ROOT_PASSWORD}
      MONGO_INITDB_DATABASE: leanez_plugins
    volumes:
      - ./data/mongodb:/data/db
    restart: unless-stopped
`;
    }

    fs.writeFileSync(path.join(pluginDir, 'docker-compose.yml'), yamlContent);
  }
}

async function createEnv(pluginDir, stacks) {
  const envVars = [...new Set(stacks.flatMap(s => s.envVars))];
  
  const envContent = [
    '# Environment variables for plugin',
    '',
    '# Node environment (development/production)',
    'NODE_ENV=development',
    '',
    `STACKS=${stacks.map(s => s.name).join(',')}`,
    ''
  ];

  envVars.forEach(envVar => {
    switch (envVar) {
      case 'REDIS_URL':
        envContent.push('REDIS_URL=redis://localhost:6379');
        break;
      case 'MONGO_URL':
        envContent.push('MONGO_URL=mongodb://admin:password123@localhost:27017');
        break;
      case 'MONGO_DB':
        envContent.push('MONGO_DB=leanez_plugins');
        break;
      default:
        envContent.push(`${envVar}=your_value_here`);
    }
  });

  fs.writeFileSync(
    path.join(pluginDir, '.env'),
    envContent.join('\n')
  );
}

// Command: start plugin server
program
  .command('start')
  .description('Start plugin server')
  .action(() => {
    const serverPath = path.join(__dirname, 'server.js');
    const child = spawn('node', [serverPath], {
      stdio: 'inherit'
    });
    
    child.on('error', (error) => {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    });
    
    child.on('exit', (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    });
  });

// Command: deploy plugin to server
program
  .command('deploy')
  .description('Deploy plugin to LeanEZ server')
  .action(async () => {
    try {
      console.log(chalk.blue('🚀 Deploying plugin...'));
      
      // Check if manifest.json exists
      const currentDir = process.cwd();
      const manifestPath = path.join(currentDir, 'manifest.json');
      
      if (!fs.existsSync(manifestPath)) {
        throw new Error('manifest.json not found in current directory');
      }
      
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      // Get config from environment
      const serverUrl = process.env.LEANEZ_BASE_URL || 'https://api.leanez.app';
      const apiKey = process.env.API_KEY;
      
      console.log(`📦 ${manifest.name} v${manifest.version}`);
      
      if (!apiKey) {
        console.log(chalk.yellow('⚠️  API_KEY not set'));
      }
      
      // Read all files in current directory (exclude node_modules, .git, etc.)
      const excludeDirs = ['node_modules', '.git', '.tmp', 'dist', 'build'];
      const excludeFiles = ['.gitignore', 'package-lock.json', 'yarn.lock'];
      
      function readDirectoryRecursive(dir, basePath = '') {
        const files = {};
        const items = fs.readdirSync(dir);
        
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const relativePath = path.join(basePath, item);
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            if (!excludeDirs.includes(item)) {
              Object.assign(files, readDirectoryRecursive(fullPath, relativePath));
            }
          } else {
            if (!excludeFiles.includes(item)) {
              files[relativePath] = fs.readFileSync(fullPath, 'utf8');
            }
          }
        }
        
        return files;
      }
      
      const pluginFiles = readDirectoryRecursive(currentDir);
      
      // Prepare deployment payload
      const deploymentData = {
        id: manifest.id || manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        functions: manifest.functions,
        manifest: manifest,
        files: pluginFiles
      };

      // Call deployment API
      console.log(chalk.blue('🚀 Deploying plugin...'));
      
      // Show loading indicator
      const loadingChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let loadingIndex = 0;
      const loadingInterval = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(loadingChars[loadingIndex])} Uploading and scanning code...`);
        loadingIndex = (loadingIndex + 1) % loadingChars.length;
      }, 100);

      try {
        const response = await axios.post(`${serverUrl}/plugins/deploy`, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_KEY || 'dev-token'}`
          },
          data: deploymentData
        });

        clearInterval(loadingInterval);
        process.stdout.write('\r' + ' '.repeat(50) + '\r'); // Clear loading line

        if (!response.data.success) {
          throw new Error(response.data.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        const result = response.data;
        console.log(chalk.green('✅ Plugin deployed successfully!'));
        if (result.deploymentId) {
          console.log(chalk.gray(`   Deployment ID: ${result.deploymentId}`));
        }
        if (result.pluginPath) {
          console.log(chalk.gray(`   Plugin Path: ${result.pluginPath}`));
        }
        if (result.message) {
          console.log(chalk.gray(`   Message: ${result.message}`));
        }
        
      } catch (error) {
        clearInterval(loadingInterval);
        process.stdout.write('\r' + ' '.repeat(50) + '\r'); // Clear loading line
        
        console.log(chalk.red('❌ Deployment failed:'), error.message);
        
        // Show helpful error details
        if (error.message.includes('fetch') || error.message.includes('ECONNREFUSED')) {
          console.log(chalk.yellow('🔧 Check if LeanEZ server is running and accessible'));
        } else if (error.message.includes('401') || error.message.includes('403')) {
          console.log(chalk.yellow('🔧 Check your API_KEY environment variable'));
        } else if (error.message.includes('Security scan failed')) {
          console.log(chalk.yellow('🔧 Your code contains security issues that need to be fixed'));
        }
        
        console.log(chalk.gray(`📁 ${Object.keys(pluginFiles).length} files were prepared for deployment`));
      }
      
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// Login command - Get API key for plugin deployment
program
  .command('login')
  .description('Login and get API key for plugin deployment')
  .option('-k, --api-key <key>', 'Set API key directly (skip authentication)')
  .action(async (options) => {
    try {
      // If API key is provided directly, skip authentication
      if (options.apiKey) {
        console.log(chalk.blue('🔑 Setting API key...'));
        
        // Add API key to .env file
        const envPath = path.join(process.cwd(), '.env');
        let envContent = '';
        
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        // Update or add API_KEY
        const apiKeyLine = `API_KEY=${options.apiKey}`;
        if (envContent.includes('API_KEY=')) {
          envContent = envContent.replace(/API_KEY=.*/, apiKeyLine);
        } else {
          envContent += envContent ? '\n' + apiKeyLine : apiKeyLine;
        }
        
        fs.writeFileSync(envPath, envContent);
        console.log(chalk.green('✅ API key set successfully!'));
        console.log(chalk.yellow('🔑 Your API Key:'), chalk.cyan(options.apiKey));
        console.log(chalk.green('💾 API key saved to .env file'));
        return;
      }
      
      // Original login flow with email/password
      console.log(chalk.blue('🔑 Login to get API key...'));
      
      // Prompt for email and password
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'email',
          message: 'Email:',
          validate: (input) => {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(input) || 'Please enter a valid email address';
          }
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password:',
          mask: '*',
          validate: (input) => input.length > 0 || 'Password is required'
        }
      ]);

      const serverUrl = process.env.LEANEZ_BASE_URL || 'https://api.leanez.app';
      
      console.log(chalk.yellow('🔄 Logging in...'));

      const response = await axios.post(`${serverUrl}/user/developer/login`, {
        email: answers.email,
        password: answers.password
      });

      const result = response.data;
      
      if (!result.success) {
        throw new Error(result.message || 'Login failed');
      }

      console.log(chalk.green('✅ Login successful!'));
      if (result.isNewUser) {
        console.log(chalk.blue('🎉 Welcome! Your developer account has been created.'));
      }
      console.log(chalk.yellow('🔑 Your API Key:'), chalk.cyan(result.apiKey));
      
      // Add API key to .env file
      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';
      
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }
      
      // Update or add API_KEY
      const apiKeyLine = `API_KEY=${result.apiKey}`;
      if (envContent.includes('API_KEY=')) {
        envContent = envContent.replace(/API_KEY=.*/, apiKeyLine);
      } else {
        envContent += envContent ? '\n' + apiKeyLine : apiKeyLine;
      }
      
      fs.writeFileSync(envPath, envContent);
      console.log(chalk.green('💾 API key saved to .env file'));
      
    } catch (error) {
      if (error.response) {
        console.log(chalk.red('❌ Login failed:'), error.response.data?.message || error.response.statusText);
      } else {
        console.log(chalk.red('❌ Login failed:'), error.message);
      }
      process.exit(1);
    }
  });

// Export programmatic API for backend usage
export {
  createPluginProject as createPlugin,
  validatePluginConfig as validateConfig,
  AVAILABLE_STACKS,
  DEFAULT_STACKS,
  OPTIONAL_STACKS
};

export const getAvailableStacks = () => AVAILABLE_STACKS;
export const getDefaultStacks = () => DEFAULT_STACKS;
export const getOptionalStacks = () => OPTIONAL_STACKS;

// Parse command line arguments
program.parse(process.argv); 