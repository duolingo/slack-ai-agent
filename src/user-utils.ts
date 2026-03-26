import fs from "fs";
import { App } from "@slack/bolt";
import * as yaml from "js-yaml";
import { Logger } from "./logger";
import { DEFAULT_EMAIL, USER_CACHE_TTL_MS } from "./constants";

const logger = new Logger("UserUtils");

interface Employee {
  email: string;
  firstName: string;
  lastName: string;
  slack?: string;
  github?: string;
  role?: string; // Access role from tool-allowlist.yaml (required for tool access)
  function?: string;
  orgs?: string[];
}

// YAML format: Record<slackUserId, EmployeeEntry>
type EmployeesYaml = Record<string, Omit<Employee, "slack">>;

interface SlackUserInfo {
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
  email?: string;
  profile?: {
    email?: string;
    display_name?: string;
    display_name_normalized?: string;
  };
}

/**
 * Consolidated user utility functions for Slack user information
 */
export class UserUtils {
  private static userInfoCache = new Map<
    string,
    { user: SlackUserInfo; fetchedAt: number }
  >();
  private static readonly CACHE_TTL_MS = USER_CACHE_TTL_MS;

  // Employee cache for role validation
  private static employeeCache: {
    slackToEmployee: Map<string, Employee>;
    fetchedAt: number;
  } | null = null;
  private static readonly EMPLOYEES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly EMPLOYEES_MISSING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
  private static cleanupIntervalId?: NodeJS.Timeout;

  /**
   * Get complete user information from Slack API with caching
   */
  static async getUserInfo(
    app: App,
    userId: string,
  ): Promise<SlackUserInfo | null> {
    // Check cache first
    const cached = this.userInfoCache.get(userId);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.user;
    }

    try {
      const response = await app.client.users.info({ user: userId });
      const user = response.user as any;

      if (!user) {
        return null;
      }

      const userInfo: SlackUserInfo = {
        id: userId,
        name: user.name,
        realName: user.real_name,
        displayName:
          user.profile?.display_name || user.profile?.display_name_normalized,
        email: user.profile?.email,
        profile: user.profile,
      };

      // Cache the result
      this.userInfoCache.set(userId, { user: userInfo, fetchedAt: now });

      return userInfo;
    } catch (error) {
      logger.warn("Failed to fetch user info", { userId, error });
      return null;
    }
  }

  /**
   * Get username for tracking/logging purposes
   * Replaces getUsernameFromUserId from tracking.ts
   */
  static async getUsername(app: App, userId: string): Promise<string> {
    const userInfo = await this.getUserInfo(app, userId);
    return userInfo?.name || userId;
  }

  /**
   * Get Slack handle with @ prefix for display in messages
   */
  static async getSlackHandle(
    app: App,
    userId: string,
  ): Promise<string | null> {
    const userInfo = await this.getUserInfo(app, userId);

    if (!userInfo) return null;

    // Prefer legacy username if available
    if (userInfo.name && userInfo.name.trim().length > 0) {
      return `@${userInfo.name}`;
    }

    // Fallback to display name
    if (userInfo.displayName && userInfo.displayName.trim().length > 0) {
      return `@${userInfo.displayName.trim()}`;
    }

    return null;
  }

  /**
   * Get employee data by Slack user ID from employees.yaml
   */
  static async getEmployeeBySlackId(userId: string): Promise<Employee | null> {
    try {
      const slackToEmployeeMap = await this.fetchEmployeeMapping();
      return slackToEmployeeMap.get(userId) || null;
    } catch (error) {
      logger.error("Error getting employee by Slack ID", { userId, error });
      return null;
    }
  }

  static readonly EMPLOYEES_FILE = "data/employees.yaml";

  /**
   * Fetch and cache Slack user ID to employee mapping from local file
   */
  private static async fetchEmployeeMapping(): Promise<Map<string, Employee>> {
    const now = Date.now();

    // Check cache first
    if (
      this.employeeCache &&
      now - this.employeeCache.fetchedAt < this.EMPLOYEES_CACHE_TTL_MS
    ) {
      return this.employeeCache.slackToEmployee;
    }

    try {
      if (!fs.existsSync(this.EMPLOYEES_FILE)) {
        logger.warn(
          "employees.yaml not found at %s — returning empty map",
          this.EMPLOYEES_FILE,
        );
        const empty = new Map<string, Employee>();
        // Use a shorter TTL so we re-check soon after the sync job creates the file
        const shortenedFetchedAt =
          now -
          this.EMPLOYEES_CACHE_TTL_MS +
          this.EMPLOYEES_MISSING_CACHE_TTL_MS;
        this.employeeCache = {
          slackToEmployee: empty,
          fetchedAt: shortenedFetchedAt,
        };
        return empty;
      }

      logger.info("Reading employee data from local file");
      const raw = fs.readFileSync(this.EMPLOYEES_FILE, "utf-8");
      const employeesYaml = (yaml.load(raw) as EmployeesYaml) ?? {};

      // Build slack user ID to employee mapping
      const slackToEmployee = new Map<string, Employee>();
      for (const [slackId, entry] of Object.entries(employeesYaml)) {
        slackToEmployee.set(slackId, { ...entry, slack: slackId });
      }

      // Cache the result
      this.employeeCache = { slackToEmployee, fetchedAt: now };

      logger.info("Successfully cached employee data", {
        count: slackToEmployee.size,
      });

      return slackToEmployee;
    } catch (error) {
      logger.error("Failed to read employee data from local file", error);
      return new Map<string, Employee>();
    }
  }

  /**
   * Get the user's role from employees.yaml.
   * Returns "none" for unknown users or employees without a role field,
   * or the role string from the employee record.
   */
  static async getUserRole(userId: string): Promise<string> {
    try {
      const employee = await this.getEmployeeBySlackId(userId);

      if (!employee) {
        logger.info("User role: not an employee", {
          userId: userId.slice(-4),
        });
        return "none";
      }

      const role = employee.role;

      if (!role) {
        logger.info("User role: employee has no role assigned", {
          userId: userId.slice(-4),
          email: employee.email,
        });
        return "none";
      }

      logger.info("User role determined", {
        userId: userId.slice(-4),
        email: employee.email,
        role,
      });

      return role;
    } catch (error) {
      logger.error("Error determining user role", { userId, error });
      return "none";
    }
  }

  /**
   * Start automatic cache cleanup interval (call once during app initialization)
   */
  static startCleanupInterval(): void {
    if (!this.cleanupIntervalId) {
      this.cleanupIntervalId = setInterval(
        () => {
          this.cleanupCache();
        },
        10 * 60 * 1000,
      );
      logger.info("Cache cleanup interval started");
    } else {
      logger.debug(
        "Cache cleanup interval already running, skipping initialization",
      );
    }
  }

  /**
   * Clean up old cached user info and employee cache periodically
   */
  static cleanupCache(): void {
    const now = Date.now();

    // Clean up user info cache
    for (const [userId, cached] of this.userInfoCache.entries()) {
      if (now - cached.fetchedAt > this.CACHE_TTL_MS) {
        this.userInfoCache.delete(userId);
      }
    }

    // Clean up employee cache if it exists and is expired
    if (
      this.employeeCache &&
      now - this.employeeCache.fetchedAt > this.EMPLOYEES_CACHE_TTL_MS
    ) {
      this.employeeCache = null;
    }
  }
}
