import { db } from "@dokploy/server/db";
import {
	type apiCreateMariaDB,
	backups,
	mariadb,
} from "@dokploy/server/db/schema";
import { generateAppName } from "@dokploy/server/db/schema";
import { generatePassword } from "@dokploy/server/templates/utils";
import { buildMariadb } from "@dokploy/server/utils/databases/mariadb";
import { pullImage } from "@dokploy/server/utils/docker/utils";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import { validUniqueServerAppName } from "./project";

import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";

export type Mariadb = typeof mariadb.$inferSelect;

export const createMariadb = async (input: typeof apiCreateMariaDB._type) => {
	input.appName =
		`${input.appName}-${generatePassword(6)}` || generateAppName("mariadb");
	if (input.appName) {
		const valid = await validUniqueServerAppName(input.appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}

	const newMariadb = await db
		.insert(mariadb)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			databaseRootPassword: input.databaseRootPassword
				? input.databaseRootPassword
				: generatePassword(),
		})
		.returning()
		.then((value) => value[0]);

	if (!newMariadb) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting mariadb database",
		});
	}

	return newMariadb;
};

// https://github.com/drizzle-team/drizzle-orm/discussions/1483#discussioncomment-7523881
export const findMariadbById = async (mariadbId: string) => {
	const result = await db.query.mariadb.findFirst({
		where: eq(mariadb.mariadbId, mariadbId),
		with: {
			project: true,
			mounts: true,
			server: true,
			backups: {
				with: {
					destination: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Mariadb not found",
		});
	}
	return result;
};

export const updateMariadbById = async (
	mariadbId: string,
	mariadbData: Partial<Mariadb>,
) => {
	const result = await db
		.update(mariadb)
		.set({
			...mariadbData,
		})
		.where(eq(mariadb.mariadbId, mariadbId))
		.returning();

	return result[0];
};

export const removeMariadbById = async (mariadbId: string) => {
	const result = await db
		.delete(mariadb)
		.where(eq(mariadb.mariadbId, mariadbId))
		.returning();

	return result[0];
};

export const findMariadbByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(mariadb),
		})
		.from(mariadb)
		.innerJoin(backups, eq(mariadb.mariadbId, backups.mariadbId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "MariaDB not found",
		});
	}
	return result[0];
};

export const deployMariadb = async (mariadbId: string) => {
	const mariadb = await findMariadbById(mariadbId);
	try {
		if (mariadb.serverId) {
			await execAsyncRemote(
				mariadb.serverId,
				`docker pull ${mariadb.dockerImage}`,
			);
		} else {
			await pullImage(mariadb.dockerImage);
		}

		await buildMariadb(mariadb);
		await updateMariadbById(mariadbId, {
			applicationStatus: "done",
		});
	} catch (error) {
		await updateMariadbById(mariadbId, {
			applicationStatus: "error",
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy mariadb${error}`,
		});
	}
	return mariadb;
};
