import React, { useState } from 'react';
import { TextField, Box, Typography, InputAdornment, IconButton, FormControl, InputLabel, OutlinedInput, Button, FormHelperText } from '@mui/material';
import { sharedStyles } from '../styles'; // Import the shared styles
import { useAppContext } from '../contexts/AppContext';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { parseDetailsFile } from '../utils';

const IMPORTED_FIELD_LABELS = {
  username: 'username',
  password: 'password',
  mobileNumber: 'mobile number',
};

function LoginDetails() {
  const { formData, handleChange, setFormData } = useAppContext();
  const [showPassword, setShowPassword] = useState(false);
  const [importMessage, setImportMessage] = useState('');

  const handleImportFile = async (event) => {
    const file = event.target.files[0];
    // Clear the picker so choosing the same file again still triggers onChange.
    event.target.value = '';
    if (!file) return;

    let text;
    try {
      text = await file.text();
    } catch (error) {
      setImportMessage(`Could not read ${file.name}.`);
      return;
    }

    const { values, invalidMobile, skippedLines } = parseDetailsFile(text);
    const filled = Object.keys(values).map((field) => IMPORTED_FIELD_LABELS[field]);
    const notes = [
      invalidMobile ? ' The mobile line was not used because it is not a 10-digit number.' : '',
      skippedLines ? ` ${skippedLines} other ${skippedLines === 1 ? 'line was' : 'lines were'} not recognised.` : '',
    ].join('');

    if (filled.length === 0) {
      setImportMessage(`Nothing was filled from ${file.name}: it has no usable user-id, password or mobile line.${notes}`);
      return;
    }

    setFormData((prevState) => ({ ...prevState, ...values }));
    setImportMessage(`Filled ${filled.join(', ')} from ${file.name}. Press Save Booking Details to keep them.${notes}`);
  };

  const handleClickShowPassword = () => setShowPassword((show) => !show);
  const handleMouseDownPassword = (event) => {
    event.preventDefault();
  };

  const handleMouseUpPassword = (event) => {
    event.preventDefault();
  };

  return (
    (<Box sx={sharedStyles.container}> {/* Apply shared container styles */}
      <Typography variant="h5" gutterBottom align="center" sx={{ fontWeight: 'bold', color: '#333' }}>
        Login Details
      </Typography>
      <TextField
        fullWidth
        label="Username"
        id="username"
        name="username"
        value={formData.username}
        onChange={handleChange}
        margin="normal"
        required
        variant="outlined"
        placeholder="Enter Irctc username"
        slotProps={{
          input: {
            sx: sharedStyles.input, // Apply shared input styles
          }
        }}
      />
      <FormControl fullWidth variant="outlined" margin="normal" >
        <InputLabel htmlFor="password">Password</InputLabel>
        <OutlinedInput
          id="password"
          type={showPassword ? 'text' : 'password'}
          value={formData.password}
          onChange={handleChange}
          name="password"
          placeholder="Enter Irctc password"
          sx={{ width: '100%', backgroundColor: 'white', borderRadius: 1, '& .MuiOutlinedInput-root': { '& fieldset': { borderRadius: 1 } } }}
          endAdornment={
            <InputAdornment position="end">
              <IconButton
                aria-label={
                  showPassword ? 'hide the password' : 'display the password'
                }
                onClick={handleClickShowPassword}
                onMouseDown={handleMouseDownPassword}
                onMouseUp={handleMouseUpPassword}
                edge="end"
              >
                {showPassword ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          }
          label="Password"
        />
      </FormControl>
      <Button component="label" variant="outlined" size="small" sx={{ mt: 1 }}>
        Import from file
        <input type="file" hidden onChange={handleImportFile} />
      </Button>
      <FormHelperText>
        {importMessage || 'Fills username, password and mobile number from a text file with lines like "user-id: yourname". See .env.example.'}
      </FormHelperText>
    </Box>)
  );
}


export default LoginDetails;
