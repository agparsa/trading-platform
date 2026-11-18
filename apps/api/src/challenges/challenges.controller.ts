import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import {
  CurrentUser,
  subjectOf,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { RATE_LIMIT_WINDOW_MS, rateLimits } from '../config/env.schema';
import { ChallengesService, type PlanInput } from './challenges.service';

/** Money and percentages arrive as strings and stay decimals. */
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,18}(\.\d{1,8})?$/, 'Use a positive decimal');
const pct = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'Use a percentage like 5 or 2.5');

const planSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    steps: z.union([z.literal(1), z.literal(2)]),
    accountSize: amount,
    accountCurrency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/),
    leverage: z.number().int().min(1).max(1000),
    price: amount,
    paymentAsset: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{2,12}$/),
    paymentNetwork: z.string().trim().min(2).max(40),
    paymentAddress: z.string().trim().min(16).max(256).nullable(),
    phaseOneTargetPct: pct,
    phaseTwoTargetPct: pct.nullable(),
    dailyLossPct: pct,
    maxLossPct: pct,
    drawdownMode: z.enum(['STATIC', 'TRAILING']),
    trailingLock: z.boolean(),
    dailyBasis: z.enum(['BALANCE', 'EQUITY', 'HIGHER']),
    minTradingDays: z.number().int().min(0).max(365),
    maxDays: z.number().int().min(1).max(3650).nullable(),
    profitSplitPct: pct,
    isActive: z.boolean(),
  })
  .strict();
class PlanDto extends createZodDto(planSchema) {}

const purchaseSchema = z.object({ planId: z.string().uuid() }).strict();
class PurchaseDto extends createZodDto(purchaseSchema) {}

const paymentSchema = z
  .object({
    transactionHash: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{32,128}$/, 'That does not look like a transaction hash'),
  })
  .strict();
class PaymentDto extends createZodDto(paymentSchema) {}

const decisionSchema = z
  .object({ confirmed: z.boolean(), reason: z.string().trim().max(500).nullable().optional() })
  .strict();
class DecisionDto extends createZodDto(decisionSchema) {}

const listSchema = z
  .object({
    status: z
      .enum(['AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'ACTIVE', 'FUNDED', 'FAILED', 'CANCELLED'])
      .optional(),
  })
  .strict();
class ListDto extends createZodDto(listSchema) {}

/**
 * A trader's challenges. Every query is scoped to the caller inside the
 * service; an id somebody pastes reaches only their own.
 */
@ApiTags('challenges')
@Controller('challenges')
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get('plans')
  @RequirePermissions(Permission.ACCOUNTS_READ)
  @ApiOperation({ summary: 'Challenges on sale' })
  plans() {
    return this.challenges.offered();
  }

  @Get()
  @RequirePermissions(Permission.ACCOUNTS_READ)
  @ApiOperation({ summary: 'Your challenges, with the evaluator’s latest figures' })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.challenges.mine(subjectOf(user));
  }

  /** Public: a certificate is for showing people. The code is the secret. */
  @Get('certificates/:code')
  @Public()
  @Throttle({ default: { limit: rateLimits.login * 6, ttl: RATE_LIMIT_WINDOW_MS } })
  @ApiOperation({ summary: 'Check a challenge certificate by its code' })
  certificate(@Param('code') code: string) {
    return this.challenges.certificate(code.trim().toUpperCase().slice(0, 32));
  }

  @Get(':id')
  @RequirePermissions(Permission.ACCOUNTS_READ)
  @ApiOperation({ summary: 'One of your challenges, with its history' })
  one(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.challenges.one(subjectOf(user), id);
  }

  @Post()
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'Buy a challenge: reserves its terms and shows where to pay' })
  purchase(@CurrentUser() user: AuthenticatedUser, @Body() body: PurchaseDto) {
    return this.challenges.purchase(subjectOf(user), body.planId);
  }

  @Post(':id/payment')
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'Say which transfer paid the fee, for staff to check' })
  payment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PaymentDto,
  ) {
    return this.challenges.submitPayment(subjectOf(user), id, body.transactionHash);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'Cancel a challenge that has not been paid for' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.challenges.cancel(subjectOf(user), id);
  }
}

/** The firm's side: plans, the payment queue, and every challenge. */
@ApiTags('admin')
@Controller('admin/challenges')
export class AdminChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get('plans')
  @RequirePermissions(Permission.PAYMENTS_READ_ANY)
  @ApiOperation({ summary: 'Every challenge plan, on sale or not' })
  plans() {
    return this.challenges.allPlans();
  }

  @Post('plans')
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Create a challenge plan' })
  createPlan(@CurrentUser() user: AuthenticatedUser, @Body() body: PlanDto) {
    return this.challenges.createPlan(user.id, body as PlanInput);
  }

  @Put('plans/:id')
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Change a plan; challenges already bought keep their terms' })
  updatePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PlanDto,
  ) {
    return this.challenges.updatePlan(user.id, id, body as PlanInput);
  }

  @Get()
  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @ApiOperation({ summary: 'Challenges, newest activity first' })
  list(@Query() query: ListDto) {
    return this.challenges.list(query.status);
  }

  @Get(':id')
  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @ApiOperation({ summary: 'One challenge, its trader and its history' })
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.challenges.one(null, id);
  }

  @Post(':id/payment-decision')
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Confirm the fee arrived — opening phase 1 — or refuse it' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionDto,
  ) {
    return this.challenges.decidePayment(user.id, id, body.confirmed, body.reason ?? null);
  }
}
