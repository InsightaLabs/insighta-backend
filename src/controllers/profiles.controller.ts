import { type Request, type Response } from "express";
import { DatabaseClient } from "../db";
import {
  AgeGroup,
  AgifyAPIResponse,
  AllProfileQueryOptions,
  GenderizeAPIResponse,
  NationalizeAPIResponse,
} from "../types";
import * as uuid from "uuid";
import {
  analyzeNaturalLanguageQuery,
  countryMap,
  isAgeGroup,
  isGender,
  isSortField,
  isSortOrder,
  normalizeQueryOptions
} from "../utils";
import { redis } from "../lib/redis";

const dbClient = new DatabaseClient();

export async function createProfile(req: Request, res: Response) {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({
      status: "error",
      message: "Missing name in request body",
    });
  }
  console.log(name);

  // This shouldn't be the only 422 case though
  if (typeof name !== "string") {
    return res.status(422).json({
      status: "error",
      message: "Unprocessable entity",
    });
  }

  try {
    const [ genderizeRes, nationalizeRes, agifyRes ] = await Promise.all([
      fetch(`https://api.genderize.io?name=${name}`),
      fetch(`https://api.nationalize.io/?name=${name}`),
      fetch(`https://api.agify.io/?name=${name}`)
    ])
    // const genderizeRes = await fetch(`https://api.genderize.io?name=${name}`);
    // const nationalizeRes = await fetch(
    //   `https://api.nationalize.io/?name=${name}`,
    // );
    // const agifyRes = await fetch(`https://api.agify.io/?name=${name}`);

    if (!genderizeRes.ok) {
      return res.status(502).json({
        status: "error",
        message: "Genderize returned an invalid response",
      });
    }

    if (!agifyRes.ok) {
      return res.status(502).json({
        status: "error",
        message: "Agify returned an invalid response",
      });
    }

    if (!nationalizeRes.ok) {
      return res.status(502).json({
        status: "error",
        message: "Nationalize returned an invalid response",
      });
    }

    const [
      { count: sample_size, probability: gender_probability, gender },
      { country }, 
      { age } 
    ]: [GenderizeAPIResponse, NationalizeAPIResponse, AgifyAPIResponse] = await Promise.all([
      genderizeRes.json(),
      nationalizeRes.json(),
      agifyRes.json(),
    ]);

    // const {
    //   count: sample_size,
    //   probability: gender_probability,
    //   gender,
    // }: GenderizeAPIResponse = await genderizeRes.json();

    if (gender === null || sample_size === 0) {
      return res.status(502).json({
        status: "error",
        message: "Genderize returned an invalid response",
      });
    }

    // const { age }: AgifyAPIResponse = await agifyRes.json();

    if (age === null || age < 0) {
      return res.status(502).json({
        status: "error",
        message: "Agify returned an invalid response",
      });
    }

    // const { country }: NationalizeAPIResponse = await nationalizeRes.json();

    const age_group: AgeGroup =
      age <= 12
        ? "child"
        : age <= 19
          ? "teenager"
          : age <= 59
            ? "adult"
            : "senior";

    if (!country || country.length === 0) {
      return res.status(502).json({
        status: "error",
        message: "Nationalize returned an invalid response",
      });
    }

    const topCountry = country.sort((a, b) => b.probability - a.probability)[0];
    const topCountryId = topCountry.country_id;

    const country_name = countryMap.get(topCountryId);

    if (!country_name) {
      return res.status(502).json({
        status: "error",
        message: "Nationalize returned an Invalid response",
      });
    }

    const record = {
      id: uuid.v7(),
      name,
      gender,
      gender_probability,
      // sample_size,
      age,
      age_group,
      country_id: topCountry.country_id,
      country_name,
      country_probability: topCountry.probability,
    };

    const { classification, duplicate } = await dbClient.insertRecord(record);
    console.log("Classification: ", classification);

    if (duplicate) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: classification,
      });
    } else {
      return res.status(201).json({
        status: "success",
        data: classification,
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}

export async function getAllProfiles(req: Request, res: Response) {
  const {
    gender,
    country_id,
    age_group,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page,
    limit,
  } = req.query;

  const baseUrl = req.baseUrl;
  const path = req.path;

  const options: AllProfileQueryOptions = {};

  if (gender !== undefined) {
    if (!gender || typeof gender !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty parameters",
      });
    }
    if (!isGender(gender)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.gender = gender;
  }

  if (country_id !== undefined) {
    if (!country_id || typeof country_id !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty parameters",
      });
    }
    const validCountry = countryMap.has(country_id);
    if (!validCountry) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query paramters",
      });
    }
    options.country_id = country_id;
  }

  if (age_group !== undefined) {
    if (!age_group || typeof age_group !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty query parameters",
      });
    }
    if (!isAgeGroup(age_group)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.age_group = age_group;
  }

  if (min_age !== undefined) {
    const parsed = parseInt(min_age as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.min_age = parsed;
  }

  if (max_age !== undefined) {
    const parsed = parseInt(max_age as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.max_age = parsed;
  }

  if (min_gender_probability !== undefined) {
    const parsed = parseFloat(min_gender_probability as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.min_gender_probability = parsed;
  }

  if (min_country_probability !== undefined) {
    const parsed = parseFloat(min_country_probability as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.min_country_probability = parsed;
  }

  if (sort_by !== undefined) {
    if (!sort_by || typeof sort_by !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty query parameters",
      });
    }
    if (!isSortField(sort_by)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.sort_by = sort_by;
  }

  if (order !== undefined) {
    if (!order || typeof order !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty query parameters",
      });
    }
    if (!isSortOrder(order)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.sort_order = order;
  }

  if (page !== undefined) {
    const parsed = parseInt(page as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.page = parsed;
  }

  if (limit !== undefined) {
    const parsed = parseInt(limit as string);
    if (isNaN(parsed)) {
      return res.status(422).json({
        status: "error",
        message: "Invalid query parameters",
      });
    }
    options.limit = parsed;
  }

  try {
    const cacheKey = `profiles:${normalizeQueryOptions(options)}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      return res.status(200).json(parsed);
    }

    const { page, limit, total, records } =
      await dbClient.getAllRecords(options);
    const totalPages = Math.ceil(total / limit);

    const responseBody = {
      status: "success",
      page,
      limit,
      total,
      total_pages: totalPages,
      links: {
        self: `${baseUrl}/${path}?page=${page}&limit=${limit}`,
        next: `${baseUrl}/${path}?page=${page + 1}&limit=${limit}`,
        prev:
          page > 1 ? `${baseUrl}/${path}?page=${page}&limit=${limit}` : null,
      },
      data: records,
    }

    await redis.set(cacheKey, JSON.stringify(responseBody), "EX", 60);

    return res.status(200).json(responseBody);
    // return res.status(200).json({
    //   status: "success",
    //   data: records,
    //   meta: {
    //     page,
    //     limit,
    //     total,
    //     totalPages
    //   }
    // })
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}

export async function searchForProfiles(req: Request, res: Response) {
  const { q } = req.query;

  const baseUrl = req.baseUrl;
  const path = req.path;

  if (!q || typeof q !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Missing or invalid query",
    });
  }

  const options = analyzeNaturalLanguageQuery(q);

  if (!options) {
    return res.status(422).json({
      status: "error",
      message: "Unable to interpret query",
    });
  }

  try {
    const cacheKey = `profiles:${normalizeQueryOptions(options)}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      return res.status(200).json(parsed);
    }

    const { page, limit, total, records } =
      await dbClient.getAllRecords(options);
    const totalPages = Math.ceil(total / limit);

    const responseBody = {
      status: "success",
      page,
      limit,
      total,
      total_pages: totalPages,
      links: {
        self: `${baseUrl}/${path}?page=${page}&limit=${limit}`,
        next: `${baseUrl}/${path}?page=${page + 1}&limit=${limit}`,
        prev:
          page > 1 ? `${baseUrl}/${path}?page=${page}&limit=${limit}` : null,
      },
      data: records,
    }

    await redis.set(cacheKey, JSON.stringify(responseBody), "EX", 60);

    return res.status(200).json(responseBody);
    // return res.status(200).json({
    //   status: "success",
    //   data: records,
    //   meta: {
    //     page,
    //     limit,
    //     total,
    //     totalPages
    //   }
    // })
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}

export async function getProfile(req: Request, res: Response) {
  const { id } = req.params;
  console.log(id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      message: "Missing name request param",
    });
  }

  if (typeof id !== "string") {
    return res.status(422).json({
      status: "error",
      message: "Unprocessable entity",
    });
  }

  try {
    const record = await dbClient.getRecord(id);

    if (!record || record === null || typeof record === "undefined") {
      return res.status(404).json({
        status: "error",
        message: `Record for ${id} does not exist`,
      });
    }
    // const dbClient = new DatabaseClient();

    return res.status(200).json({
      status: "success",
      data: record,
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}

export async function deleteProfile(req: Request, res: Response) {
  const { id } = req.params;
  console.log(id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      message: "Missing id request param",
    });
  }

  if (typeof id !== "string") {
    return res.status(422).json({
      status: "error",
      message: "Unprocessable entity",
    });
  }

  try {
    await dbClient.deleteRecord(id);
    res.status(204).send();
  } catch (err) {
    if ((err as Error).message.includes("not found")) {
      res
        .status(404)
        .json({ status: "error", message: (err as Error).message });
    } else {
      res
        .status(500)
        .json({ status: "error", message: "Internal server error" });
    }
  }
}

export async function exportCSV(req: Request, res: Response) {
  const {
    gender,
    country_id,
    age_group,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    format,
  } = req.query;
  console.log("Request to export...");

  if (!format || typeof format !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Export format required",
    });
  }

  if (format.toLowerCase() !== "csv") {
    return res.status(400).json({
      status: "error",
      message: "Invalid export format",
    });
  }

  const options: AllProfileQueryOptions = {
    limit: 1000, // fetch all — no pagination for export
    page: 1,
  };

  if (gender !== undefined) {
    if (!isGender(gender as string)) {
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    }
    options.gender = gender as AllProfileQueryOptions["gender"];
  }

  if (country_id !== undefined) {
    if (!countryMap.has(country_id as string)) {
      return res
        .status(422)
        .json({ status: "error", message: "Invalid country_id" });
    }
    options.country_id = country_id as string;
  }

  if (age_group !== undefined) {
    if (!isAgeGroup(age_group as string)) {
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    }
    options.age_group = age_group as AllProfileQueryOptions["age_group"];
  }

  if (min_age !== undefined) {
    const parsed = parseInt(min_age as string);
    if (isNaN(parsed))
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    options.min_age = parsed;
  }

  if (max_age !== undefined) {
    const parsed = parseInt(max_age as string);
    if (isNaN(parsed))
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    options.max_age = parsed;
  }

  if (min_gender_probability !== undefined) {
    const parsed = parseFloat(min_gender_probability as string);
    if (isNaN(parsed))
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    options.min_gender_probability = parsed;
  }

  if (min_country_probability !== undefined) {
    const parsed = parseFloat(min_country_probability as string);
    if (isNaN(parsed))
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    options.min_country_probability = parsed;
  }

  if (sort_by !== undefined) {
    if (!isSortField(sort_by as string)) {
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    }
    options.sort_by = sort_by as AllProfileQueryOptions["sort_by"];
  }

  if (order !== undefined) {
    if (!isSortOrder(order as string)) {
      return res
        .status(422)
        .json({ status: "error", message: "Invalid query parameters" });
    }
    options.sort_order = order as AllProfileQueryOptions["sort_order"];
  }

  try {
    const { records } = await dbClient.getAllRecords(options);

    const { stringify } = await import("csv-stringify");

    const columns = [
      "id",
      "name",
      "gender",
      "gender_probability",
      "age",
      "age_group",
      "country_id",
      "country_name",
      "country_probability",
      "created_at",
    ];

    let now = new Date().toISOString();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="profiles_${now}.csv"`,
    );

    const stringifier = stringify({ header: true, columns });

    stringifier.pipe(res);

    for (const record of records) {
      stringifier.write(record);
    }

    stringifier.end();
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}
