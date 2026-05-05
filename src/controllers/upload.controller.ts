import Busboy from "busboy";
import { parse } from 'csv-parse'
import { Request, Response } from "express";
import { AgeGroup, InsertRecord, RawCSVRow } from "../types";
import { DatabaseClient } from "../db";
import { v7 } from "uuid";
import { countryMap, countryNameMap, isAgeGroup, isGender } from "../utils";

const dbClient = new DatabaseClient();

const parseCSVField = (row: RawCSVRow): {
    kind: "error" | "success",
    response: InsertRecord | string
} => {
    if (!row.name || typeof row.name !== 'string' || row.name.length === 0) {
        return { kind: "error",  response: "Name not found" };
    }
    const name = row.name

    if (!row.gender || typeof row.gender !== 'string' || !isGender(row.gender)) {
        return { kind: "error", response: "Invalid Gender" };
    }
    const gender = row.gender;

    if (!row.gender_probability || typeof row.gender_probability !== 'string' || isNaN(parseFloat(row.gender_probability))) {
        return { kind: "error", response: "Invalid Gender probability" }
    }
    const gender_probability = parseFloat(row.gender_probability);

    if (!row.age || typeof row.age !== 'string' || isNaN(parseInt(row.age))) {
        return { kind: "error", response: "Invalid age" }
    }
    const age = parseInt(row.age);
    if (age < 0 ) return { kind: "error", response: "Invalid age" }

    let age_group: AgeGroup = "" as AgeGroup;

    if (!row.age_group || typeof row.age_group !== 'string' || !isAgeGroup(row.age_group)) {
        age_group = age <= 12
        ? "child"
        : age <= 19
          ? "teenager"
          : age <= 59
            ? "adult"
            : "senior";
    } else {
        age_group = row.age_group;
    }

    let country_id: string = ""
    if (row.country_id !== undefined) {
        if (row.country_id && typeof row.country_id === 'string' && countryMap.has(row.country_id.toUpperCase())) {
            country_id = row.country_id.toUpperCase();
        } else if (row.country_name && typeof row.country_name === 'string') {
            const found = countryNameMap.get(row.country_name.toLowerCase());
            if (found) {
                country_id = found;
            } else {
                return { kind: "error", response: "Invalid country ID" };
            }
        } else {
            return { kind: "error", response: "Invalid country ID" };
        }

    };

    if (country_id.length === 0) return { kind: "error", response: "Invalid country ID" }

    // let country_name: string = "";
    const country_name = countryMap.get(country_id);
    if (!country_name) return { kind: "error", response: "Invalid country name" };

    if (!row.country_probability || typeof row.country_probability !== 'string' || isNaN(parseFloat(row.country_probability))) {
        return { kind: "error", response: "Invalid Gender probability" }
    }
    const country_probability = parseFloat(row.country_probability);

    return {
        kind: "success",
        response: {
            id: v7(),
            name,
            gender,
            gender_probability,
            age,
            age_group,
            country_id,
            country_name,
            country_probability,
        }
    }
}

export function handleCSVUpload(req: Request, res: Response) {
    const busboy = Busboy({ headers: req.headers });

    const stats = {
        total_rows: 0,
        inserted: 0,
        skipped: 0,
        reasons: {
            duplicate_name: 0,
            invalid_age: 0,
            invalid_gender: 0,
            invalid_country: 0,
            missing_fields: 0
        }
    };

    const batch: {
        id: string;
        name: string;
        gender: "male" | "female";
        gender_probability: number;
        // sample_size: number;
        age: number;
        age_group: "adult" | "child" | "teenager" | "senior";
        country_id: string;
        country_name: string;
        country_probability: number;
    }[] = [];
    const BATCH_SIZE = 5000;

    let processStreamFunction: Promise<any>;

    busboy.on('file', (_fieldname, file, _info) => {
        const parser = parse({ columns: true });

        const processStream = new Promise<void>((resolve, reject) => {
            parser.on('data', (row: RawCSVRow) => {
                stats.total_rows++;
                const recordOrError = parseCSVField(row);

                if (recordOrError.kind === "success") {
                    batch.push(recordOrError.response as InsertRecord)
                } else {
                    stats.skipped = stats.skipped + 1;
                    if (recordOrError.response === "Invalid age") {
                        stats.reasons.invalid_age++;
                    } else if (recordOrError.response === "Invalid Gender") {
                        stats.reasons.invalid_gender++;
                    } else if (recordOrError.response === "Invalid country name") {
                        stats.reasons.invalid_country++;
                    } else {
                        stats.reasons.missing_fields++
                    }
                }
                
                
                // sync validation and accumulation only
                
            });

            parser.on('end', async () => {
                // flush remaining batch here
                const chunks = [];
                const CHUNKS_SIZE = 15; // number of chunks to do at once. If you do all, pg fails
                for (let i = 0; i < batch.length; i += BATCH_SIZE) {
                    chunks.push(batch.slice(i, i + BATCH_SIZE));
                }
                // const results = await Promise.all(chunks.map(chunk => dbClient.batchInsertRecords(chunk)));

                for (let i = 0; i < chunks.length; i += CHUNKS_SIZE) {
                    const current_chunk_group = chunks.slice(i, i + CHUNKS_SIZE);
                    const results = await Promise.all(current_chunk_group.map(grp => dbClient.batchInsertRecords(grp)));

                    for (const result of results) {
                        stats.inserted += result.inserted;
                        stats.reasons.duplicate_name += result.duplicates;
                        stats.skipped += result.duplicates
                    }
                }

                // for (let i = 0; i < batch.length; i += BATCH_SIZE) {
                //     const chunk = batch.slice(i, i + BATCH_SIZE);
                //     const result = await dbClient.batchInsertRecords(chunk)
                //     stats.inserted += result.inserted;
                //     stats.reasons.duplicate_name += result.duplicates;
                //     stats.skipped += result.duplicates;
                // }
                batch.length = 0;
                resolve();
            })

            parser.on('error', reject);
        })

        file.pipe(parser)
        
        processStreamFunction = processStream;
    })

    busboy.on('finish', async () => {
        await processStreamFunction;
        return res.status(201).json({
            status: "success",
            ...stats
        })
    })

    req.pipe(busboy);
}