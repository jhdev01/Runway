import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/types';

export class ConfigStore {
  private filePath: string;

  constructor() {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'config.json');
  }

  read(): AppConfig {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.write(DEFAULT_CONFIG);
        return DEFAULT_CONFIG;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      // Merge with defaults so newly added fields work for existing installs
      return { ...DEFAULT_CONFIG, ...parsed, version: 1 };
    } catch (err) {
      console.error('[config] read failed, returning defaults', err);
      return DEFAULT_CONFIG;
    }
  }

  write(config: AppConfig): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] write failed', err);
    }
  }

  getPath(): string {
    return this.filePath;
  }
}
