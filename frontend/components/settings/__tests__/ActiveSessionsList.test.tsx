import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ActiveSessionsList } from '../ActiveSessionsList';
import * as sessionsApi from '@/lib/api/sessions';

jest.mock('@/lib/api/sessions');

const mockSessions = [
  {
    id: 'session-1',
    device: 'Chrome on Windows',
    location: 'Abuja, Nigeria',
    lastActive: '2026-08-26T12:00:00Z',
    isCurrent: true,
  },
  {
    id: 'session-2',
    device: 'Safari on iPhone',
    location: 'Lagos, Nigeria',
    lastActive: '2026-08-25T10:00:00Z',
    isCurrent: false,
  },
];

describe('ActiveSessionsList Component (#2000)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (sessionsApi.fetchSessions as jest.Mock).mockResolvedValue(mockSessions);
  });

  it('should render session devices and current device badge', async () => {
    render(<ActiveSessionsList />);

    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    expect(screen.getByText('This Device')).toBeInTheDocument();
  });

  it('should revoke a session when revoke button is clicked', async () => {
    window.confirm = jest.fn(() => true);
    (sessionsApi.revokeSession as jest.Mock).mockResolvedValue({});

    render(<ActiveSessionsList />);

    const revokeButtons = await screen.findAllByRole('button', { name: /Revoke/i });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => {
      expect(sessionsApi.revokeSession).toHaveBeenCalledWith('session-2');
    });
  });

  it('should log out all other sessions when button is clicked', async () => {
    window.confirm = jest.fn(() => true);
    (sessionsApi.revokeOtherSessions as jest.Mock).mockResolvedValue({});

    render(<ActiveSessionsList />);

    const logOutOthersBtn = await screen.findByRole('button', { name: /Log Out All Other Sessions/i });
    fireEvent.click(logOutOthersBtn);

    await waitFor(() => {
      expect(sessionsApi.revokeOtherSessions).toHaveBeenCalled();
    });
  });
});